import { describe, it, expect } from "vitest";
import { createGateway } from "../src/gateway/gateway.js";
import { loadUpstreams, MockImageVendor, type FetchLike } from "../src/gateway/upstreams.js";
import type { SteelRunner } from "../src/gateway/recovery.js";

const SECRET = "gw-secret";
const upstreams = loadUpstreams();

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

function gw(opts: { fetchImpl?: FetchLike; steel?: SteelRunner; env?: NodeJS.ProcessEnv } = {}) {
  const mock = new MockImageVendor(0);
  const steel = opts.steel ?? fakeSteel().steel;
  const g = createGateway({
    upstreams,
    steel,
    mockVendor: mock,
    env: opts.env ?? { OPENAI_API_KEY: "sk-test" },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    safeBlockMs: 30,
    pollMs: 5,
    publicUrl: () => "http://127.0.0.1:0",
    mandateSecret: SECRET,
    log: () => {},
  });
  return { g, mock };
}

const json = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content[0]?.text ?? "{}");

describe("gateway intercept", () => {
  it("re-exports namespaced vendor tools", () => {
    const { g } = gw();
    expect(g.tools.map((t) => t.name).sort()).toEqual(["mockvendor__generate_image", "openai__chat"]);
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

  it("an OpenAI rate limit is not a wall", async () => {
    const body = { error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" } };
    const { g } = gw({ fetchImpl: openAiFetch(429, body, { "retry-after": "0" }) });
    const r = await g.callTool("openai__chat", { prompt: "hi" }, { taskId: "t" });
    expect(r.isError).toBe(true);
    expect(g.coordinator.list()).toHaveLength(0);
  });

  it("mock vendor 402 → approve → Steel → credited → replays the exact call", async () => {
    const { steel, runs } = fakeSteel();
    const { g, mock } = gw({ steel });
    const args = { prompt: "hero image #1" };
    const first = json((await g.callTool("mockvendor__generate_image", args, { taskId: "t" })) as never);
    const job = g.coordinator.get(first.recovery_id)!;
    expect(job.checkpoint.blocker).toMatchObject({ type: "INSUFFICIENT_CREDITS", resource: "image_credits", required: 1067 });
    // 1,000 credits can't clear a 1,067 shortfall, so the smallest viable pack is 5,000.
    expect(job.quote?.productId).toBe("c5000");

    await g.coordinator.approve(job.id, job.mandate!.signature);
    const replayed = json((await g.waitForRecovery(job.id)) as never);
    expect(replayed.url).toMatch(/cdn\.mockvendor/);
    expect(replayed.prompt).toBe("hero image #1");
    expect(runs[0]?.billingOrigin).toBe("https://example.com");
    expect(mock.balance).toBe(5000 - 1067);
    expect((await g.coordinator.spendFor("t")).task).toBe(20);
  });

  it("the agent retrying the blocked call joins the same recovery", async () => {
    const { g } = gw();
    const a = json((await g.callTool("mockvendor__generate_image", { prompt: "x" }, { taskId: "t" })) as never);
    const b = json((await g.callTool("mockvendor__generate_image", { prompt: "x" }, { taskId: "t" })) as never);
    expect(b.recovery_id).toBe(a.recovery_id);
    expect(g.coordinator.list()).toHaveLength(1);
  });

  it("approval needs the mandate signature and is idempotent on a double tap", async () => {
    const { steel, runs } = fakeSteel();
    const { g } = gw({ steel });
    const { recovery_id } = json((await g.callTool("mockvendor__generate_image", { prompt: "x" }, { taskId: "t" })) as never);
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
    const { recovery_id } = json((await g.callTool("mockvendor__generate_image", { prompt: "x" }, { taskId: "t" })) as never);
    g.coordinator.reject(recovery_id);
    const r = await g.waitForRecovery(recovery_id);
    expect(r.isError).toBe(false);
    expect(json(r as never).status).toBe("REJECTED");
    expect(runs).toHaveLength(0);
  });

  it("a Steel failure surfaces as RECOVERY_FAILED", async () => {
    const { g } = gw({ steel: fakeSteel("STEEL_API_KEY is required").steel });
    const { recovery_id } = json((await g.callTool("mockvendor__generate_image", { prompt: "x" }, { taskId: "t" })) as never);
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
