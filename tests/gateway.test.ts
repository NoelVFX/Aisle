import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createGateway } from "../src/gateway/gateway.js";
import { loadUpstreams, type FetchLike, type VendorTool } from "../src/gateway/upstreams.js";
import type { SteelPurchaser, SteelRunner } from "../src/gateway/recovery.js";
import { FakeImageVendor, VENDOR_ORIGIN, creditingPurchaser, imageVendorEntry, upstreamsWith } from "./helpers/image-vendor.js";

const SECRET = "gw-secret";
const upstreams = upstreamsWith(imageVendorEntry());

function fakeSteel(fail?: string) {
  const runs: Array<{ provider: string; billingOrigin: string }> = [];
  const steel: SteelRunner = {
    async run({ provider, billingOrigin, emit }) {
      runs.push({ provider, billingOrigin });
      if (fail) throw new Error(fail);
      emit("STEEL_SESSION_CREATED", { sessionId: "sess_fake" });
      return { sessionId: "sess_fake", viewerUrl: "https://app.steel.dev/sessions/sess_fake", finalUrl: billingOrigin + "/", title: "Billing", screenshotPath: undefined };
    },
  };
  return { steel, runs };
}

function openAiFetch(status: number, body: unknown, headers: Record<string, string> = {}): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { forEach: (cb) => Object.entries(headers).forEach(([k, v]) => cb(v, k)) },
    text: async () => JSON.stringify(body),
  });
}

function gw(opts: { fetchImpl?: FetchLike; steel?: SteelRunner; env?: NodeJS.ProcessEnv; purchase?: (v: FakeImageVendor) => SteelPurchaser } = {}) {
  const vendor = new FakeImageVendor(0);
  const steel = opts.steel ?? fakeSteel().steel;
  const g = createGateway({
    upstreams: opts.purchase ? upstreamsWith(imageVendorEntry({ purchase: true })) : upstreams,
    steel,
    extraTools: [vendor.tool()],
    ...(opts.purchase ? { purchaser: opts.purchase(vendor) } : {}),
    env: { AISLE_INITIAL_BLOCK_MS: "1", ...(opts.env ?? { OPENAI_API_KEY: "sk-test" }) },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    safeBlockMs: 30,
    pollMs: 5,
    publicUrl: () => "http://127.0.0.1:0",
    mandateSecret: SECRET,
    log: () => {},
  });
  return { g, vendor };
}

function higgsfield403Tool(): VendorTool {
  return {
    name: "higgsfield__generate_image",
    namespace: "higgsfield",
    description: "Test Higgsfield tool.",
    inputShape: { prompt: z.string() },
    call: async () => ({ ok: false, status: 403, headers: {}, body: { detail: "not_enough_credits" } }),
  };
}

const json = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content[0]?.text ?? "{}");

describe("gateway intercept", () => {
  it("re-exports namespaced vendor tools", () => {
    const { g } = gw();
    expect(g.tools.map((t) => t.name).sort()).toEqual(["imagevendor__generate_image", "openai__chat", "openrouter__chat"]);
  });

  it("a blank OpenAI key (401) passes through untouched and opens no recovery", async () => {
    const body = { error: { message: "You didn't provide an API key.", type: "invalid_request_error", code: null } };
    const { g } = gw({ fetchImpl: openAiFetch(401, body), env: { OPENAI_API_KEY: "" } });
    const r = await g.callTool("openai__chat", { prompt: "hi" }, { taskId: "t" });
    expect(r.isError).toBe(true);
    expect(json(r as never)).toEqual({ status: 401, error: body });
    expect(g.coordinator.list()).toHaveLength(0);
  });

  it("OpenAI insufficient_quota opens a recovery on the config-locked billing origin", async () => {
    const body = { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } };
    const { steel, runs } = fakeSteel();
    const { g } = gw({ fetchImpl: openAiFetch(429, body), steel });
    const first = json((await g.callTool("openai__chat", { prompt: "hi" }, { taskId: "t" })) as never);
    expect(first.status).toBe("AWAITING_APPROVAL");
    expect(first.next).toMatch(/Do NOT re-run the original tool/);

    const job = g.coordinator.get(first.recovery_id)!;
    expect(job.checkpoint.origin.billingOrigin).toBe("https://platform.openai.com");
    expect(job.quote?.productId).toBe("openai_credits_5");
    expect((await g.coordinator.approve(job.id, job.mandate!.signature)).ok).toBe(true);

    const done = json((await g.waitForRecovery(job.id)) as never);
    expect(done.status).toBe("DRY_RUN_COMPLETE");
    expect(done.steel.sessionId).toBe("sess_fake");
    expect(runs).toEqual([{ provider: "openai", billingOrigin: "https://platform.openai.com" }]);
  });

  it("recognizes the live 'no credits remaining' body (credit_balance_exhausted)", async () => {
    const body = {
      error: {
        message: "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
        type: "insufficient_quota",
        param: null,
        code: "credit_balance_exhausted",
      },
    };
    const { g } = gw({ fetchImpl: openAiFetch(429, body) });
    const first = json((await g.callTool("openai__chat", { prompt: "hi" }, { taskId: "t" })) as never);
    expect(first.status).toBe("AWAITING_APPROVAL");
    expect(g.coordinator.get(first.recovery_id)?.checkpoint.blocker).toMatchObject({ type: "INSUFFICIENT_CREDITS", resource: "usd_balance" });
  });

  it("Higgsfield 403 not_enough_credits opens a recovery", async () => {
    const higgsfield = loadUpstreams(undefined, {})["higgsfield"]!;
    const g = createGateway({
      upstreams: Object.freeze({ ...upstreams, higgsfield }),
      steel: fakeSteel().steel,
      extraTools: [higgsfield403Tool()],
      env: { AISLE_INITIAL_BLOCK_MS: "1" },
      safeBlockMs: 30,
      pollMs: 5,
      publicUrl: () => "http://127.0.0.1:0",
      mandateSecret: SECRET,
      log: () => {},
    });

    const first = json((await g.callTool("higgsfield__generate_image", { prompt: "a red bicycle" }, { taskId: "t" })) as never);
    expect(first.status).toBe("AWAITING_APPROVAL");
    expect(g.coordinator.get(first.recovery_id)?.checkpoint.blocker).toMatchObject({ type: "INSUFFICIENT_CREDITS", resource: "image_credits" });
  });

  it("does not block if wait_for_recovery is called before approval", async () => {
    const { g } = gw();
    const first = json((await g.callTool("imagevendor__generate_image", { prompt: "x" }, { taskId: "t" })) as never);
    const started = Date.now();
    const waited = json((await g.waitForRecovery(first.recovery_id)) as never);

    expect(Date.now() - started).toBeLessThan(100);
    expect(waited).toMatchObject({
      status: "AWAITING_APPROVAL",
      recovery_id: first.recovery_id,
      approve_url: expect.any(String),
      next: expect.stringContaining("Do NOT re-run the original tool"),
    });
  });

  it("opens the configured billing page, goes live, and holds Steel until the user ends it", async () => {
    const body = { error: { type: "insufficient_quota", code: "credit_balance_exhausted", message: "You have no credits remaining." } };
    let requested: string | undefined;
    let released = false;
    const steel: SteelRunner = {
      async run({ billingUrl, onLive, hold }) {
        requested = billingUrl;
        onLive({ sessionId: "s1", debugUrl: "https://api.steel.dev/v1/sessions/s1/player", viewerUrl: "https://app.steel.dev/sessions/s1" });
        await hold;
        released = true;
        return { sessionId: "s1", debugUrl: undefined, viewerUrl: undefined, finalUrl: billingUrl, title: "Billing", screenshotPath: undefined };
      },
    };
    const live: string[] = [];
    const g = createGateway({
      upstreams,
      steel,
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: openAiFetch(429, body),
      safeBlockMs: 30,
      pollMs: 5,
      publicUrl: () => "http://127.0.0.1:0",
      mandateSecret: SECRET,
      log: () => {},
      onSteelLive: (j) => live.push(j.live?.debugUrl ?? ""),
    });
    const { recovery_id } = json((await g.callTool("openai__chat", { prompt: "hi" }, { taskId: "t" })) as never);
    const job = g.coordinator.get(recovery_id)!;
    await g.coordinator.approve(job.id, job.mandate!.signature);
    await new Promise((r) => setTimeout(r, 10));

    expect(requested).toBe("https://platform.openai.com/settings/organization/billing/overview");
    expect(live).toEqual(["https://api.steel.dev/v1/sessions/s1/player"]);
    expect(job.live?.sessionId).toBe("s1");
    expect(released).toBe(false);
    expect(json((await g.waitForRecovery(job.id)) as never).status).toBe("RECOVERY_RUNNING");

    expect(g.coordinator.releaseSteel(job.id)).toBe(true);
    expect(json((await g.waitForRecovery(job.id)) as never).status).toBe("DRY_RUN_COMPLETE");
    expect(released).toBe(true);
    expect(job.live).toBeUndefined();
  });

  it("refuses a billingUrl that leaves the billing origin", () => {
    const dir = mkdtempSync(join(tmpdir(), "aisle-up-"));
    const file = join(dir, "upstreams.json");
    writeFileSync(file, JSON.stringify({ evil: { description: "", canonicalOrigin: "https://api.v.test", billingOrigin: "https://v.test", billingUrl: "https://evil-example.com/buy", resource: "credits", offers: [] } }));
    expect(() => loadUpstreams(file)).toThrow(/billingUrl must be on its billingOrigin/);
  });

  it("an OpenAI rate limit is not a wall", async () => {
    const body = { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } };
    const { g } = gw({ fetchImpl: openAiFetch(429, body, { "retry-after": "0" }) });
    const r = await g.callTool("openai__chat", { prompt: "hi" }, { taskId: "t" });
    expect(r.isError).toBe(true);
    expect(g.coordinator.list()).toHaveLength(0);
  });

  it("vendor 402 → approve → purchase → credited → replays the exact call", async () => {
    const seen: Array<{ realMoneyAllowed: boolean; billingOrigin: string }> = [];
    const { g, vendor } = gw({ purchase: (v) => creditingPurchaser(v, seen) });
    const args = { prompt: "hero image #1" };
    const first = json((await g.callTool("imagevendor__generate_image", args, { taskId: "t" })) as never);
    const job = g.coordinator.get(first.recovery_id)!;
    expect(job.checkpoint.blocker).toMatchObject({ type: "INSUFFICIENT_CREDITS", resource: "image_credits", required: 1067 });
    // 1,000 credits can't clear a 1,067 shortfall, so the smallest viable pack is 5,000.
    expect(job.quote?.productId).toBe("c5000");

    await g.coordinator.approve(job.id, job.mandate!.signature);
    const replayed = json((await g.waitForRecovery(job.id)) as never);
    expect(replayed.url).toMatch(/cdn\.vendor\.test/);
    expect(replayed.prompt).toBe("hero image #1");
    expect(seen).toEqual([{ realMoneyAllowed: true, billingOrigin: VENDOR_ORIGIN }]);
    expect(vendor.balance).toBe(5000 - 1067);
    expect((await g.coordinator.spendFor("t")).task).toBe(20);
  });

  it("the agent retrying the blocked call joins the same recovery", async () => {
    const { g } = gw();
    const a = json((await g.callTool("imagevendor__generate_image", { prompt: "x" }, { taskId: "t" })) as never);
    const b = json((await g.callTool("imagevendor__generate_image", { prompt: "x" }, { taskId: "t" })) as never);
    expect(b.recovery_id).toBe(a.recovery_id);
    expect(g.coordinator.list()).toHaveLength(1);
  });

  it("approval needs the mandate signature and is idempotent on a double tap", async () => {
    const { steel, runs } = fakeSteel();
    const { g } = gw({ steel });
    const { recovery_id } = json((await g.callTool("imagevendor__generate_image", { prompt: "x" }, { taskId: "t" })) as never);
    const job = g.coordinator.get(recovery_id)!;
    expect((await g.coordinator.approve(job.id, "forged")).error).toBe("MANDATE_SIGNATURE_MISMATCH");
    await g.coordinator.approve(job.id, job.mandate!.signature);
    await g.coordinator.approve(job.id, job.mandate!.signature);
    await g.waitForRecovery(job.id);
    expect(runs).toHaveLength(1);
  });

  it("reject returns a normal tool result and never opens Steel", async () => {
    const { steel, runs } = fakeSteel();
    const { g } = gw({ steel });
    const { recovery_id } = json((await g.callTool("imagevendor__generate_image", { prompt: "x" }, { taskId: "t" })) as never);
    g.coordinator.reject(recovery_id);
    const r = await g.waitForRecovery(recovery_id);
    expect(r.isError).toBe(false);
    expect(json(r as never).status).toBe("REJECTED");
    expect(runs).toHaveLength(0);
  });

  it("a Steel failure surfaces as RECOVERY_FAILED", async () => {
    const { g } = gw({ steel: fakeSteel("STEEL_API_KEY is required").steel });
    const { recovery_id } = json((await g.callTool("imagevendor__generate_image", { prompt: "x" }, { taskId: "t" })) as never);
    const job = g.coordinator.get(recovery_id)!;
    await g.coordinator.approve(job.id, job.mandate!.signature);
    const r = await g.waitForRecovery(job.id);
    expect(r.isError).toBe(true);
    expect(json(r as never)).toMatchObject({ status: "RECOVERY_FAILED", error: "STEEL_API_KEY is required" });
  });

  it("never recovers Aisle's own infra key", async () => {
    const body = { error: { code: "insufficient_quota", message: "You exceeded your current quota" } };
    const { g } = gw({ fetchImpl: openAiFetch(429, body), env: { OPENAI_API_KEY: "same", OPENROUTER_INFRA_KEY: "same" } });
    const r = await g.callTool("openai__chat", { prompt: "hi" }, { taskId: "t" });
    expect(r.content[0]).toMatchObject({ text: expect.stringMatching(/INFRA_BLOCKED/) });
    expect(g.coordinator.list()).toHaveLength(0);
  });
});
