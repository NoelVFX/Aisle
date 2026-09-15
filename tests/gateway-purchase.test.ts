import { describe, it, expect } from "vitest";
import { createGateway } from "../src/gateway/gateway.js";
import type { FetchLike } from "../src/gateway/upstreams.js";
import type { SteelPurchaser, SteelRunner } from "../src/gateway/recovery.js";
import { runSlowLane } from "../src/slow-lane/executor.js";
import { FakeBrowserProvider, FakeShopAdapter, FakeShopSite } from "./helpers/fake-shop.js";
import { InMemoryIdempotencyStore } from "../src/fast-lane/idempotency.js";
import { SubmitWithheldError } from "../src/index.js";
import { makeRequest, SECRET } from "./fixtures.js";
import { FakeImageVendor, VENDOR_ORIGIN, creditingPurchaser, imageVendorEntry, upstreamsWith } from "./helpers/image-vendor.js";

const noViewing: SteelRunner = { run: async () => { throw new Error("viewing lane must not run"); } };
const json = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content[0]?.text ?? "{}");

describe("gateway slow lane", () => {
  const upstreams = upstreamsWith(imageVendorEntry({ purchase: true }));

  it("approval runs the purchaser; a verified purchase replays the exact call", async () => {
    const vendor = new FakeImageVendor(0);
    const calls: Array<{ realMoneyAllowed: boolean; billingOrigin: string }> = [];
    const purchaser = creditingPurchaser(vendor, calls);
    const g = createGateway({ upstreams, steel: noViewing, purchaser, extraTools: [vendor.tool()], safeBlockMs: 30, pollMs: 5, publicUrl: () => "http://x", mandateSecret: SECRET, log: () => {} });

    const { recovery_id } = json((await g.callTool("imagevendor__generate_image", { prompt: "hero" }, { taskId: "t" })) as never);
    const job = g.coordinator.get(recovery_id)!;
    await g.coordinator.approve(job.id, job.mandate!.signature);
    const result = json((await g.waitForRecovery(job.id)) as never);

    expect(result).toMatchObject({ prompt: "hero", url: expect.stringContaining("cdn.vendor.test") });
    expect(calls).toEqual([{ realMoneyAllowed: true, billingOrigin: VENDOR_ORIGIN }]);
    expect(job.lane).toBe("slow");
    expect((await g.coordinator.spendFor("t")).task).toBe(20);
  });

  it("a real-money vendor that isn't allowlisted is staged but never submitted", async () => {
    const body = { error: { type: "insufficient_quota", code: "credit_balance_exhausted", message: "You have no credits remaining." } };
    const openAiFetch: FetchLike = async () => ({ ok: false, status: 429, headers: { forEach: () => {} }, text: async () => JSON.stringify(body) });
    const seen: boolean[] = [];
    const purchaser: SteelPurchaser = {
      async purchase({ realMoneyAllowed }) {
        seen.push(realMoneyAllowed);
        return { outcome: "withheld", staged: { lineItem: "$5 API credits", amount: 5, currency: "USD", billingPeriod: "one_time", autoRenew: false } };
      },
    };
    const g = createGateway({ upstreams, steel: noViewing, purchaser, env: { OPENAI_API_KEY: "sk" }, fetchImpl: openAiFetch, safeBlockMs: 30, pollMs: 5, publicUrl: () => "http://x", mandateSecret: SECRET, log: () => {} });

    const { recovery_id } = json((await g.callTool("openai__chat", { prompt: "2+2" }, { taskId: "t" })) as never);
    const job = g.coordinator.get(recovery_id)!;
    await g.coordinator.approve(job.id, job.mandate!.signature);
    const result = json((await g.waitForRecovery(job.id)) as never);
    expect(seen).toEqual([false]);
    expect(result).toMatchObject({ status: "STAGED_NOT_SUBMITTED", staged: { amount: 5 } });
    expect((await g.coordinator.spendFor("t")).task).toBe(0);
  });

  it("an allowlisted real-money vendor is allowed to submit", async () => {
    const seen: boolean[] = [];
    const purchaser: SteelPurchaser = { async purchase({ realMoneyAllowed }) { seen.push(realMoneyAllowed); throw new Error("stop here"); } };
    const body = { error: { code: "credit_balance_exhausted" } };
    const g = createGateway({
      upstreams, steel: noViewing, purchaser, realPurchaseProviders: new Set(["openai"]), env: { OPENAI_API_KEY: "sk" },
      fetchImpl: async () => ({ ok: false, status: 429, headers: { forEach: () => {} }, text: async () => JSON.stringify(body) }),
      safeBlockMs: 30, pollMs: 5, publicUrl: () => "http://x", mandateSecret: SECRET, log: () => {},
    });
    const { recovery_id } = json((await g.callTool("openai__chat", { prompt: "2+2" }, { taskId: "t" })) as never);
    const job = g.coordinator.get(recovery_id)!;
    await g.coordinator.approve(job.id, job.mandate!.signature);
    expect(json((await g.waitForRecovery(job.id)) as never).status).toBe("RECOVERY_FAILED");
    expect(seen).toEqual([true]);
  });

  it("a login wall fails with the login instruction", async () => {
    const purchaser: SteelPurchaser = {
      async purchase() { throw Object.assign(new Error("Not authenticated with the vendor and re-authentication failed."), { code: "NOT_AUTHENTICATED" }); },
    };
    const body = { error: { code: "credit_balance_exhausted" } };
    const g = createGateway({
      upstreams, steel: noViewing, purchaser, env: { OPENAI_API_KEY: "sk" },
      fetchImpl: async () => ({ ok: false, status: 429, headers: { forEach: () => {} }, text: async () => JSON.stringify(body) }),
      safeBlockMs: 30, pollMs: 5, publicUrl: () => "http://x", mandateSecret: SECRET, log: () => {},
    });
    const { recovery_id } = json((await g.callTool("openai__chat", { prompt: "2+2" }, { taskId: "t" })) as never);
    const job = g.coordinator.get(recovery_id)!;
    await g.coordinator.approve(job.id, job.mandate!.signature);
    expect(json((await g.waitForRecovery(job.id)) as never).error).toMatch(/npm run login -- openai/);
  });
});

describe("slow lane stopBeforeSubmit", () => {
  it("stages and passes Gate 1, then stops without consuming the mandate or clicking submit", async () => {
    const site = new FakeShopSite({ provider: "mock-slow-vendor", origin: "https://shop.mock-slow-vendor.test", startingBalance: 0 });
    const store = new InMemoryIdempotencyStore();
    const request = makeRequest({ provider: "mock-slow-vendor", origin: "https://shop.mock-slow-vendor.test" });
    const events: string[] = [];
    const err = await runSlowLane(request, {
      provider: new FakeBrowserProvider(site),
      adapter: new FakeShopAdapter(site),
      store,
      mandateSecret: SECRET,
      stopBeforeSubmit: true,
      emit: (e) => events.push(e.type),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SubmitWithheldError);
    expect((err as SubmitWithheldError).staged.amount).toBe(20);
    expect(events).toContain("MANDATE_COMPARISON_PASSED");
    expect(events).toContain("SUBMIT_WITHHELD");
    expect(events).not.toContain("PURCHASE_SUBMITTED");
    expect(site.purchaseClicks).toBe(0);
    expect(await store.consumeMandate(request.mandate.mandateId)).toBe(true);
  });
});
