/** MO XIA's plan selection and recovery session state machine, wired into the gateway. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createGateway } from "../src/gateway/gateway.js";
import { loadUpstreams, type FetchLike } from "../src/gateway/upstreams.js";
import type { SteelPurchaser, SteelRunner } from "../src/gateway/recovery.js";
import { FakeImageVendor, creditingPurchaser, imageVendorEntry, upstreamsWith } from "./helpers/image-vendor.js";

const SECRET = "moxia-secret";
const json = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content[0]?.text ?? "{}");
const fastSteel: SteelRunner = {
  async run({ billingUrl }) {
    return { sessionId: "s", debugUrl: undefined, viewerUrl: undefined, finalUrl: billingUrl, title: undefined, screenshotPath: undefined };
  },
};

let previousCeiling: string | undefined;
beforeEach(() => {
  previousCeiling = process.env["LIMIT_PER_PURCHASE"];
  process.env["LIMIT_PER_PURCHASE"] = "100"; // lets the $80 pack be a real alternative
});
afterEach(() => {
  if (previousCeiling === undefined) delete process.env["LIMIT_PER_PURCHASE"];
  else process.env["LIMIT_PER_PURCHASE"] = previousCeiling;
});

function inProcess() {
  const vendor = new FakeImageVendor(0);
  const g = createGateway({
    upstreams: upstreamsWith(imageVendorEntry({ purchase: true })),
    steel: fastSteel,
    purchaser: creditingPurchaser(vendor),
    extraTools: [vendor.tool()],
    env: { AISLE_INITIAL_BLOCK_MS: "1" },
    safeBlockMs: 30,
    pollMs: 5,
    publicUrl: () => "http://x",
    mandateSecret: SECRET,
    log: () => {},
  });
  return { g, mock: vendor };
}

async function open(g: ReturnType<typeof createGateway>) {
  const first = json((await g.callTool("imagevendor__generate_image", { prompt: "hero" }, { taskId: "t" })) as never);
  return { first, job: g.coordinator.get(first.recovery_id)! };
}

describe("plan recommendation + customer selection", () => {
  it("recommends the docs' cheapest quote and offers the other viable plans", async () => {
    const { g } = inProcess();
    const { first, job } = await open(g);
    expect(job.plans?.recommended.id).toBe("c5000");
    expect(job.plans?.alternatives.map((p) => p.id)).toEqual(["c25000"]); // c1000 can't cover 1,067
    expect(job.selectedPlanId).toBe("c5000");
    expect(first.plans.alternatives[0].id).toBe("c25000");
    expect(job.session.status).toBe("AWAITING_APPROVAL");
  });

  it("switching plans re-gates and re-signs the mandate, so approval binds the choice", async () => {
    const { g, mock } = inProcess();
    const { job } = await open(g);
    const oldSignature = job.mandate!.signature;

    expect(await g.coordinator.selectPlan(job.id, "c25000")).toEqual({ ok: true });
    expect(job.quote).toMatchObject({ productId: "c25000", unitsGranted: 25000, price: 80 });
    expect(job.mandate!.productId).toBe("c25000");
    expect(job.mandate!.signature).not.toBe(oldSignature);
    expect(job.events.map((e) => e.type)).toContain("PLAN_SELECTED");
    expect(job.session.status).toBe("AWAITING_APPROVAL");

    expect((await g.coordinator.approve(job.id, oldSignature)).error).toBe("MANDATE_SIGNATURE_MISMATCH");
    await g.coordinator.approve(job.id, job.mandate!.signature);
    const replay = json((await g.waitForRecovery(job.id)) as never);
    expect(replay.credits_remaining).toBe(25000 - 1067);
    expect(mock.balance).toBe(25000 - 1067);
    expect(job.session.status).toBe("READY_TO_RESUME");
  });

  it("refuses unknown plans and plans over the per-task ceiling without changing anything", async () => {
    process.env["LIMIT_PER_TASK"] = "50";
    try {
      const { g } = inProcess();
      const { job } = await open(g);
      const before = job.mandate!.signature;
      expect((await g.coordinator.selectPlan(job.id, "nope")).ok).toBe(false);
      const overTask = await g.coordinator.selectPlan(job.id, "c25000");
      expect(overTask.ok).toBe(false);
      expect(overTask.error).toMatch(/ceiling/);
      expect(job.mandate!.signature).toBe(before);
      expect(job.selectedPlanId).toBe("c5000");
    } finally {
      delete process.env["LIMIT_PER_TASK"];
    }
  });

  it("no plan changes after approval", async () => {
    const { g } = inProcess();
    const { job } = await open(g);
    await g.coordinator.approve(job.id, job.mandate!.signature);
    expect((await g.coordinator.selectPlan(job.id, "c25000")).ok).toBe(false);
    await g.waitForRecovery(job.id);
  });
});

describe("recovery session state machine", () => {
  const sessionTrail = (job: { events: Array<{ type: string; detail: Record<string, unknown> }> }) =>
    job.events.filter((e) => e.type === "SESSION_STATUS").map((e) => e.detail["status"]);

  it("walks every step of a successful recovery in order", async () => {
    const { g } = inProcess();
    const { job } = await open(g);
    await g.coordinator.approve(job.id, job.mandate!.signature);
    await g.waitForRecovery(job.id);
    expect(sessionTrail(job)).toEqual([
      "PLAN_RECOMMENDED",
      "CUSTOMER_SELECTED",
      "AWAITING_APPROVAL",
      "APPROVED",
      "PURCHASING",
      "PURCHASED",
      "ENTITLEMENT_UPDATED",
      "READY_TO_RESUME",
    ]);
  });

  it("ends PURCHASE_WITHHELD when a real-money submit is not enabled", async () => {
    const upstreams = loadUpstreams(undefined, {});
    const body = { error: { code: "credit_balance_exhausted", type: "insufficient_quota" } };
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 429, headers: { forEach: () => {} }, text: async () => JSON.stringify(body) });
    const purchaser: SteelPurchaser = {
      async purchase() {
        return { outcome: "withheld", staged: { lineItem: "$5", amount: 5, currency: "USD", billingPeriod: "one_time", autoRenew: false } };
      },
    };
    const g = createGateway({ upstreams, steel: fastSteel, purchaser, env: { OPENAI_API_KEY: "sk", AISLE_INITIAL_BLOCK_MS: "1" }, fetchImpl, safeBlockMs: 30, pollMs: 5, publicUrl: () => "http://x", mandateSecret: SECRET, log: () => {} });
    const first = json((await g.callTool("openai__chat", { prompt: "2+2" }, { taskId: "t" })) as never);
    const job = g.coordinator.get(first.recovery_id)!;
    await g.coordinator.approve(job.id, job.mandate!.signature);
    await g.waitForRecovery(job.id);
    expect(job.session.status).toBe("PURCHASE_WITHHELD");
  });

  it("an unverified purchase ends PURCHASE_UNKNOWN, an explicit failure PURCHASE_FAILED", async () => {
    const make = (code: string) => {
      const upstreams = upstreamsWith(imageVendorEntry({ purchase: true }));
      const purchaser: SteelPurchaser = { async purchase() { throw Object.assign(new Error(code), { code }); } };
      return createGateway({ upstreams, steel: fastSteel, purchaser, extraTools: [new FakeImageVendor(0).tool()], env: { AISLE_INITIAL_BLOCK_MS: "1" }, safeBlockMs: 30, pollMs: 5, publicUrl: () => "http://x", mandateSecret: SECRET, log: () => {} });
    };
    for (const [code, expected] of [["PURCHASE_VERIFICATION_FAILED", "PURCHASE_UNKNOWN"], ["CONFIRM_NOT_FOUND", "PURCHASE_FAILED"]] as const) {
      const g = make(code);
      const { job } = await open(g);
      await g.coordinator.approve(job.id, job.mandate!.signature);
      await g.waitForRecovery(job.id);
      expect(job.session.status).toBe(expected);
    }
  });
});
