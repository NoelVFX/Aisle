/** Regression tests for the fast-lane audit findings. */

import { createServer, type Server } from "node:http";
import { describe, it, expect } from "vitest";
import { runFastLane } from "../src/fast-lane/executor.js";
import { runSlowLane } from "../src/slow-lane/executor.js";
import { InMemoryIdempotencyStore, purchaseKeyFor } from "../src/fast-lane/idempotency.js";
import { resolveRequirement } from "../src/core/outcome.js";
import { FakeWebMcpVendor } from "./helpers/fake-webmcp-vendor.js";
import { McpWebMcpSession } from "../src/webmcp/mcp-http-session.js";
import { detectWebMcp } from "../src/webmcp/detector.js";
import { FakeBrowserProvider, FakeShopAdapter, FakeShopSite } from "./helpers/fake-shop.js";
import { buildSessionCreateParams } from "../src/slow-lane/steel-provider.js";
import { PurchaseVerificationError } from "../src/index.js";
import { makeRequest, SECRET } from "./fixtures.js";

const PROVIDER = "mock-image-api";
const ORIGIN = "https://api.mock-image-api.test";
const req = () => makeRequest({ provider: PROVIDER, origin: ORIGIN });
const fastDeps = (session: FakeWebMcpVendor, store: InMemoryIdempotencyStore) => ({
  session,
  store,
  mandateSecret: SECRET,
  verifyRetry: { attempts: 1, delayMsBetween: 0 },
});

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

describe("1. vendor idempotency key is unique per approved mandate", () => {
  it("a later, independent shortfall in the same task really charges again", async () => {
    const vendor = new FakeWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const store = new InMemoryIdempotencyStore();
    const first = req();
    await runFastLane(first, fastDeps(vendor, store));
    await store.forget(purchaseKeyFor(first.mandate, resolveRequirement(first)));

    vendor.balance = 0;
    const second = await runFastLane(req(), fastDeps(vendor, store));
    expect(vendor.chargeCount).toBe(2);
    expect(second.verifiedEntitlement.balance).toBe(5000);
  });

  it("retrying the SAME mandate still reuses its key, so the vendor can dedupe", async () => {
    const vendor = new FakeWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const keys: string[] = [];
    const original = vendor.callTool.bind(vendor);
    vendor.callTool = async (name, args) => {
      if (name === "purchase_credits") keys.push(String(args["idempotency_key"]));
      return original(name, args);
    };
    const r = req();
    await runFastLane(r, fastDeps(vendor, new InMemoryIdempotencyStore()));
    expect(keys[0]).toBe(`${purchaseKeyFor(r.mandate, resolveRequirement(r))}:${r.mandate.mandateId}`);
  });
});

describe("2. a balance for a different resource never counts", () => {
  it("refuses ALREADY_COVERED when the vendor's balance is for another resource", async () => {
    const vendor = new FakeWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, startingBalance: 4000 });
    const r = req();
    r.requirement = { resource: "image_credits", amount: 3200 };
    await expect(runFastLane(r, fastDeps(vendor, new InMemoryIdempotencyStore()))).rejects.toBeInstanceOf(PurchaseVerificationError);
    expect(vendor.purchaseCallCount).toBe(0);
  });

  it("accepts a balance that names no resource", async () => {
    const vendor = new FakeWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, startingBalance: 4000 });
    const original = vendor.callTool.bind(vendor);
    vendor.callTool = async (name, args) => {
      const out = await original(name, args);
      if (name === "get_credit_balance") delete out.structuredContent?.["resource"];
      return out;
    };
    const r = req();
    r.requirement = { resource: "image_credits", amount: 3200 };
    const result = await runFastLane(r, fastDeps(vendor, new InMemoryIdempotencyStore()));
    expect(result.alreadyCovered).toBe(true);
    expect(result.verifiedEntitlement.resource).toBe("image_credits");
  });
});

describe("3. MCP session connection", () => {
  it("does not cache a failed connect", async () => {
    const session = new McpWebMcpSession({ provider: "p", url: "http://127.0.0.1:9/mcp" });
    const e1 = await session.connect().catch((e: unknown) => e);
    const e2 = await session.connect().catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(Error);
    expect(e2).toBeInstanceOf(Error);
    expect(e2).not.toBe(e1);
  });
});

describe("4. MCP session refuses redirects", () => {
  it("never sends the request to a redirect target", async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits += 1;
      res.end("{}");
    });
    const targetPort = await listen(target);
    const redirector = createServer((_req, res) => {
      res.writeHead(307, { location: `http://localhost:${targetPort}/steal` });
      res.end();
    });
    const port = await listen(redirector);
    try {
      const session = new McpWebMcpSession({ provider: "p", url: `http://127.0.0.1:${port}/mcp`, headers: { "x-api-key": "vendor-key" } });
      await expect(session.connect()).rejects.toBeTruthy();
      expect(targetHits).toBe(0);
    } finally {
      redirector.close();
      target.close();
    }
  });
});

describe("5. the slow lane keeps an unverified purchase blocking", () => {
  it("does not let a new mandate buy again after a failed Gate 2", async () => {
    const site = new FakeShopSite({ provider: "mock-slow-vendor", origin: "https://shop.mock-slow-vendor.test", dropCredits: true });
    const store = new InMemoryIdempotencyStore();
    const make = () => makeRequest({ provider: "mock-slow-vendor", origin: "https://shop.mock-slow-vendor.test" });
    const deps = { provider: new FakeBrowserProvider(site), adapter: new FakeShopAdapter(site), store, mandateSecret: SECRET };

    const first = make();
    await expect(runSlowLane(first, deps)).rejects.toBeInstanceOf(PurchaseVerificationError);
    expect((await store.get(purchaseKeyFor(first.mandate, resolveRequirement(first))))?.status).toBe("SUBMITTED");

    await expect(runSlowLane(make(), deps)).rejects.toBeInstanceOf(PurchaseVerificationError);
    expect(site.purchaseClicks).toBe(1);
  });
});

describe("purchase tool detection", () => {
  it("never picks a read-only or merely similar-named tool to spend money", async () => {
    const tools = [
      { name: "get_purchase_credits_history", annotations: { readOnlyHint: true } },
      { name: "purchase_credits", annotations: { readOnlyHint: true } },
      { name: "get_credit_balance", annotations: { readOnlyHint: true } },
    ];
    const detection = await detectWebMcp({ origin: ORIGIN, provider: PROVIDER, listTools: async () => tools, callTool: async () => ({ isError: true }) });
    expect(detection.viable).toBe(false);
  });
});

describe("web path worker session", () => {
  it("starts from a captured session context, never a profile, and persists nothing", () => {
    const ctx = { cookies: [{ name: "sid", value: "x" }] };
    const plan = buildSessionCreateParams({}, { provider: "mockvendor", sessionContext: ctx }, {});
    expect(plan.params.sessionContext).toEqual(ctx);
    expect(plan.params.persistProfile).toBe(false);
    expect(plan.params.profileId).toBeUndefined();
  });
});
