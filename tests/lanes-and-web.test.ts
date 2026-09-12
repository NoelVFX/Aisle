import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createGateway } from "../src/gateway/gateway.js";
import type { FastPurchaser, SteelPurchaser, SteelRunner } from "../src/gateway/recovery.js";
import { createFastPurchaser } from "../src/gateway/fast-purchaser.js";
import { startHttpGateway } from "../src/gateway/http-server.js";
import { InMemoryIdempotencyStore } from "../src/fast-lane/idempotency.js";
import { FileEnrollmentStore } from "../src/web/enrollments.js";
import { handleWireResponse } from "../src/web/detector.js";
import { FakeWebMcpVendor } from "./helpers/fake-webmcp-vendor.js";
import { makeRequest, SECRET } from "./fixtures.js";
import { FakeImageVendor, imageVendorEntry, upstreamsWith } from "./helpers/image-vendor.js";

const noViewing: SteelRunner = { run: async () => { throw new Error("viewing lane must not run"); } };
const json = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content[0]?.text ?? "{}");
const upstreams = upstreamsWith(imageVendorEntry({ mcp: true }));

async function recover(g: ReturnType<typeof createGateway>, taskId = "t") {
  const { recovery_id } = json((await g.callTool("imagevendor__generate_image", { prompt: "hero" }, { taskId })) as never);
  const job = g.coordinator.get(recovery_id)!;
  await g.coordinator.approve(job.id, job.mandate!.signature);
  return { job, result: await g.waitForRecovery(job.id) };
}

describe("lane router (§13)", () => {
  it("uses the fast lane first when the vendor has MCP purchase tools", async () => {
    const vendor = new FakeImageVendor(0);
    const slowCalls: string[] = [];
    const fastPurchaser: FastPurchaser = {
      async purchase({ job }) {
        vendor.credit(job.quote!.unitsGranted);
        return { outcome: "verified", result: { lane: "fast", purchaseId: "p", alreadyCovered: false, verifiedEntitlement: { balance: vendor.balance } as never, resumeToken: {} as never } };
      },
    };
    const purchaser: SteelPurchaser = { async purchase({ job }) { slowCalls.push(job.id); throw new Error("slow lane must not run"); } };
    const g = createGateway({ upstreams, steel: noViewing, purchaser, fastPurchaser, extraTools: [vendor.tool()], safeBlockMs: 30, pollMs: 5, publicUrl: () => "http://x", mandateSecret: SECRET, log: () => {} });

    const { job, result } = await recover(g);
    expect(json(result as never).url).toMatch(/cdn\.vendor\.test/);
    expect(job.lane).toBe("fast");
    expect(slowCalls).toEqual([]);
  });

  it("falls back to the Steel browser only when the vendor has no viable purchase tools", async () => {
    const vendor = new FakeImageVendor(0);
    const fastPurchaser: FastPurchaser = { async purchase() { return { outcome: "no_fast_lane", reason: "no purchase tool" }; } };
    const purchaser: SteelPurchaser = {
      async purchase({ job }) {
        vendor.credit(job.quote!.unitsGranted);
        return { outcome: "verified", result: { lane: "slow", purchaseId: "p", alreadyCovered: false, verifiedEntitlement: { balance: vendor.balance } as never, resumeToken: {} as never } };
      },
    };
    const g = createGateway({ upstreams, steel: noViewing, purchaser, fastPurchaser, extraTools: [vendor.tool()], safeBlockMs: 30, pollMs: 5, publicUrl: () => "http://x", mandateSecret: SECRET, log: () => {} });
    const { job } = await recover(g);
    expect(job.lane).toBe("slow");
    expect(job.events.map((e) => e.type)).toContain("FAST_LANE_UNAVAILABLE");
  });

  it("a fast-lane error after connecting is never retried in the browser", async () => {
    const vendor = new FakeImageVendor(0);
    let slow = 0;
    const fastPurchaser: FastPurchaser = { async purchase() { throw new Error("socket hang up mid-purchase"); } };
    const purchaser: SteelPurchaser = { async purchase() { slow += 1; throw new Error("no"); } };
    const g = createGateway({ upstreams, steel: noViewing, purchaser, fastPurchaser, extraTools: [vendor.tool()], safeBlockMs: 30, pollMs: 5, publicUrl: () => "http://x", mandateSecret: SECRET, log: () => {} });
    const { result } = await recover(g);
    expect(json(result as never).status).toBe("RECOVERY_FAILED");
    expect(slow).toBe(0);
  });

  it("createFastPurchaser returns no_fast_lane when the endpoint can't be reached, and releases a verified record", async () => {
    const store = new InMemoryIdempotencyStore();
    const unreachable = createFastPurchaser({ store, connect: async () => { throw new Error("ECONNREFUSED"); } });
    const r = makeRequest({ provider: "imagevendor", origin: "https://shop.vendor.test" });
    const job = { id: "j", namespace: "imagevendor", checkpoint: r.checkpoint, quote: r.quote, mandate: r.mandate } as never;
    expect((await unreachable.purchase({ job, upstream: upstreams["imagevendor"]!, emit: () => {} })).outcome).toBe("no_fast_lane");

    const vendor = new FakeWebMcpVendor({ provider: "imagevendor", origin: "https://shop.vendor.test" });
    const ok = createFastPurchaser({ store, mandateSecret: SECRET, connect: async () => Object.assign(vendor, { close: async () => {} }) });
    const out = await ok.purchase({ job, upstream: upstreams["imagevendor"]!, emit: () => {} });
    expect(out.outcome).toBe("verified");
  });
});

describe("shared HTTP MCP gateway (§5.1)", () => {
  it("serves namespaced tools to separate agent sessions, each its own task", async () => {
    const g = createGateway({ upstreams, steel: noViewing, extraTools: [new FakeImageVendor(0).tool()], safeBlockMs: 30, pollMs: 5, publicUrl: () => "http://x", mandateSecret: SECRET, log: () => {} });
    const http = await startHttpGateway({ gateway: g, log: () => {} }, { port: 0 });
    const clients: Client[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const c = new Client({ name: `agent-${i}`, version: "0" });
        await c.connect(new StreamableHTTPClientTransport(new URL(http.url)));
        clients.push(c);
      }
      const { tools } = await clients[0]!.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["openai__chat", "imagevendor__generate_image", "aisle__wait_for_recovery"]));

      const a = json((await clients[0]!.callTool({ name: "imagevendor__generate_image", arguments: { prompt: "x" } })) as never);
      const b = json((await clients[1]!.callTool({ name: "imagevendor__generate_image", arguments: { prompt: "x" } })) as never);
      expect(a.status).toBe("AWAITING_APPROVAL");
      expect(g.coordinator.get(a.recovery_id)!.taskId).not.toBe(g.coordinator.get(b.recovery_id)!.taskId);
    } finally {
      for (const c of clients) await c.close();
      await http.close();
    }
  });

  it("requires the bearer key when one is set", async () => {
    const g = createGateway({ upstreams, steel: noViewing, publicUrl: () => "http://x", log: () => {} });
    const http = await startHttpGateway({ gateway: g, log: () => {} }, { port: 0, key: "secret" });
    try {
      const res = await fetch(http.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(401);
    } finally {
      await http.close();
    }
  });
});

describe("web path", () => {
  const store = () => new FileEnrollmentStore(join(mkdtempSync(join(tmpdir(), "aisle-enroll-")), "enrollments.json"), upstreams);

  it("enrollment copies origins from the catalogue and matches wire origins", () => {
    const s = store();
    const e = s.enroll("u", "imagevendor");
    expect(e.billingOrigin).toBe("https://shop.vendor.test");
    expect(s.byOrigin("u", "https://SHOP.vendor.test:443")?.provider).toBe("imagevendor");
    expect(s.byOrigin("u", "https://evil-example.com")).toBeUndefined();
    expect(() => s.enroll("u", "not-a-vendor")).toThrow();
  });

  it("wire decisions: ignore, rate limit, suggest, not a wall, recovery", async () => {
    const s = store();
    s.enroll("u", "imagevendor");
    const opened: unknown[] = [];
    const suggested: string[] = [];
    const deps = {
      lookupEnrollment: (o: string) => s.byOrigin("u", o),
      suggestEnrollment: (o: string) => void suggested.push(o),
      openRecovery: async (i: unknown) => void opened.push(i),
    };
    const wall = JSON.stringify({ code: "insufficient_credits", required_credits: 1067 });
    const res = (status: number, url: string, body?: string, headers: Record<string, string> = {}) => ({ status, url, headers, getBody: async () => body });

    expect(await handleWireResponse(res(200, "https://shop.vendor.test/api/generate"), deps)).toBe("ignored");
    expect(await handleWireResponse(res(429, "https://shop.vendor.test/api/generate", "{}", { "Retry-After": "8" }), deps)).toBe("rate_limited");
    expect(await handleWireResponse(res(402, "https://unknown.example/api", wall), deps)).toBe("suggested");
    expect(await handleWireResponse(res(403, "https://shop.vendor.test/api/generate", JSON.stringify({ error: "Forbidden" })), deps)).toBe("not_a_wall");
    expect(await handleWireResponse(res(402, "https://shop.vendor.test/api/generate", wall), deps)).toBe("recovery");
    expect(suggested).toEqual(["https://unknown.example"]);
    expect(opened).toHaveLength(1);
    expect((opened[0] as { blocker: { required: number } }).blocker.required).toBe(1067);
  });

  it("an evicted body still opens a low-confidence recovery on a 402", async () => {
    const s = store();
    s.enroll("u", "imagevendor");
    let blocker: { confidence: string } | undefined;
    const decision = await handleWireResponse(
      { status: 402, url: "https://shop.vendor.test/api/generate", headers: {}, getBody: async () => undefined },
      { lookupEnrollment: (o) => s.byOrigin("u", o), suggestEnrollment: () => {}, openRecovery: async (i) => void (blocker = i.blocker) },
    );
    expect(decision).toBe("recovery");
    expect(blocker?.confidence).toBe("low");
  });
});
