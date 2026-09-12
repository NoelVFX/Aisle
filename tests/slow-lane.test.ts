import { describe, it, expect } from "vitest";
import { runSlowLane } from "../src/slow-lane/executor.js";
import {
  MockBrowserProvider,
  MockVendorAdapter,
  MockVendorSite,
  type MockVendorConfig,
} from "../src/slow-lane/adapters/mock-vendor-site.js";
import { InMemoryProfileStore } from "../src/slow-lane/profiles.js";
import { ScriptedComputerUseAgent } from "../src/slow-lane/computer-use.js";
import { InMemoryIdempotencyStore } from "../src/fast-lane/idempotency.js";
import {
  MandateMismatchError,
  MandateRejectedError,
  PurchaseFailedError,
  PurchaseVerificationError,
  ResolutionExhaustedError,
  chooseMinimumOffer,
  type SlowLaneDeps,
} from "../src/index.js";
import { makeRequest, SECRET } from "./fixtures.js";

const PROVIDER = "mock-slow-vendor";
/** makeRequest signs mandates for this user. */
const USER = "demo-user";
const ORIGIN = "https://shop.mock-slow-vendor.test";
const req = () => makeRequest({ provider: PROVIDER, origin: ORIGIN });

function setup(cfg: MockVendorConfig = {}, extra: Partial<SlowLaneDeps> = {}) {
  const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0, ...cfg });
  const events: string[] = [];
  const deps: SlowLaneDeps = {
    provider: new MockBrowserProvider(site),
    adapter: new MockVendorAdapter(site),
    mandateSecret: SECRET,
    emit: (e) => events.push(e.type),
    ...extra,
  };
  return { site, deps, events };
}

describe("slow lane — happy path", () => {
  it("navigates, stages, passes Gate 1, submits, verifies, saves a profile", async () => {
    const profiles = new InMemoryProfileStore();
    const { site, deps, events } = setup({}, { profiles });
    const result = await runSlowLane(req(), deps);

    expect(result.lane).toBe("slow");
    expect(site.purchaseClicks).toBe(1);
    expect(result.verifiedEntitlement.balance).toBe(5000);
    expect(result.resumeToken.resumeAction).toEqual({ tool: "generate_image", arguments: { prompt: "hero #2" } });
    expect(await profiles.load(USER, PROVIDER)).toBeDefined();
    const staged = events.indexOf("CHECKOUT_STAGED");
    const compared = events.indexOf("MANDATE_COMPARISON_PASSED");
    const submitted = events.indexOf("PURCHASE_SUBMITTED");
    expect(staged).toBeGreaterThan(-1);
    expect(staged).toBeLessThan(compared);
    expect(compared).toBeLessThan(submitted);
  });
});

describe("slow lane — Steel profiles (steel.md §6)", () => {
  it("creates a pinned profile on the first run, then restores the same profile and IP", async () => {
    const profiles = new InMemoryProfileStore();
    const { site, deps, events } = setup({}, { profiles });
    const provider = new MockBrowserProvider(site, { dedicatedIpId: "fixed:ip1" });
    deps.provider = provider;

    await runSlowLane(req(), deps);
    expect(provider.created[0]?.profile).toBeUndefined();
    expect(events).toContain("PROFILE_CREATED");
    const first = await profiles.load(USER, PROVIDER);
    expect(first).toMatchObject({ userId: USER, provider: PROVIDER, profileId: "prof_mock_1", dedicatedIpId: "fixed:ip1" });
    expect(first?.lastVerifiedAt).toBeDefined();

    await runSlowLane(req(), deps);
    expect(provider.created[1]?.profile).toMatchObject({ profileId: "prof_mock_1", dedicatedIpId: "fixed:ip1" });
    expect(await profiles.load(USER, PROVIDER)).toMatchObject({ profileId: "prof_mock_1" });
  });

  it("waits for READY after release, only on a verified outcome", async () => {
    const { deps, events } = setup({}, { profiles: new InMemoryProfileStore() });
    await runSlowLane(req(), deps);
    expect(events.indexOf("SESSION_CLOSED")).toBeLessThan(events.indexOf("PROFILE_READY"));
    expect((deps.provider as MockBrowserProvider).awaitedProfiles).toEqual(["prof_mock_1"]);
  });

  it("binds a new profile on a failed job but never marks it verified or waits on it", async () => {
    const profiles = new InMemoryProfileStore();
    const { deps, events } = setup({ dropCredits: true }, { profiles });
    await expect(runSlowLane(req(), deps)).rejects.toBeInstanceOf(PurchaseVerificationError);
    const saved = await profiles.load(USER, PROVIDER);
    expect(saved?.profileId).toBe("prof_mock_1");
    expect(saved?.lastVerifiedAt).toBeUndefined();
    expect(events).not.toContain("PROFILE_READY");
  });

  it("never puts a profileId in an event", async () => {
    const payloads: string[] = [];
    const { deps } = setup({}, { profiles: new InMemoryProfileStore() });
    deps.emit = (e) => payloads.push(JSON.stringify(e));
    await runSlowLane(req(), deps);
    await runSlowLane(req(), deps);
    expect(payloads.join("\n")).not.toContain("prof_mock_");
  });
});

describe("slow lane — guards", () => {
  it("rejects an origin-lock violation before touching checkout", async () => {
    const { site, deps } = setup({ redirectOrigin: "https://evil-shop.test" });
    await expect(runSlowLane(req(), deps)).rejects.toBeInstanceOf(MandateRejectedError);
    expect(site.purchaseClicks).toBe(0);
  });
});

describe("slow lane — Gate 1: staged checkout vs mandate (§18)", () => {
  const cases: Array<[string, MockVendorConfig, string]> = [
    ["amount over the cap", { checkoutSurcharge: 30 }, "AMOUNT_EXCEEDS_MANDATE"],
    ["currency mismatch", { checkoutCurrency: "EUR" }, "CURRENCY_MISMATCH"],
    ["subscription when one-time expected", { checkoutBillingPeriod: "subscription" }, "UNEXPECTED_SUBSCRIPTION"],
    ["auto-renew enabled", { checkoutAutoRenew: true }, "AUTO_RENEW_ENABLED"],
  ];
  for (const [name, cfg, reason] of cases) {
    it(`aborts before submit on ${name}`, async () => {
      const { site, deps } = setup(cfg);
      const err = await runSlowLane(req(), deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MandateMismatchError);
      expect((err as MandateMismatchError).reason).toBe(reason);
      expect(site.purchaseClicks).toBe(0);
    });
  }

  it("allows tax within the cap (cap, not price)", async () => {
    const { site, deps } = setup({ checkoutSurcharge: 4 });
    await runSlowLane(req(), deps);
    expect(site.purchaseClicks).toBe(1);
  });
});

describe("slow lane — verification (§18 Gate 2)", () => {
  it("fails when checkout completes but credits never post", async () => {
    const { deps } = setup({ dropCredits: true });
    await expect(runSlowLane(req(), deps)).rejects.toBeInstanceOf(PurchaseVerificationError);
  });

  it("fails on a pre-existing balance when the purchase adds nothing (delta, not absolute)", async () => {
    const { deps } = setup({ startingBalance: 1000, dropCredits: true });
    await expect(runSlowLane(req(), deps)).rejects.toBeInstanceOf(PurchaseVerificationError);
  });

  it("response lost after submit → PURCHASE_RESULT_UNKNOWN → verified by balance, no second click", async () => {
    const { site, deps, events } = setup({ loseResponseAfterConfirm: true });
    const result = await runSlowLane(req(), deps);
    expect(events).toContain("PURCHASE_RESULT_UNKNOWN");
    expect(site.purchaseClicks).toBe(1);
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });

  it("fails early (no purchase) when no offer can satisfy the requirement", async () => {
    const { site, deps } = setup();
    const r = makeRequest({ provider: PROVIDER, origin: ORIGIN, required: 999_999 });
    await expect(runSlowLane(r, deps)).rejects.toMatchObject({ code: "NO_VIABLE_OFFER" });
    expect(site.purchaseClicks).toBe(0);
  });
});

describe("slow lane — a model never submits (§16.1)", () => {
  it("does not hand a missing confirm control to the resolver", async () => {
    let agentCalls = 0;
    const agent = { run: async () => ((agentCalls += 1), { success: true, steps: 1 }) };
    const { site, deps } = setup({ hideConfirm: true }, { agent });
    const err = await runSlowLane(req(), deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PurchaseFailedError);
    expect((err as PurchaseFailedError).code).toBe("CONFIRM_NOT_FOUND");
    expect(agentCalls).toBe(0);
    expect(site.purchaseClicks).toBe(0);
  });
});

describe("slow lane — resolver fallback and budget (§16.6)", () => {
  it("recovers a failed discovery step via the resolver, then completes", async () => {
    const agent = new ScriptedComputerUseAgent([{ type: "click", x: 100, y: 200 }, { type: "done", success: true }]);
    const { deps } = setup({ failDiscoverUntilAssisted: true }, { agent });
    const result = await runSlowLane(req(), deps);
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });

  it("fails without a resolver when a deterministic step can't complete", async () => {
    const { site, deps } = setup({ failDiscoverUntilAssisted: true });
    await expect(runSlowLane(req(), deps)).rejects.toBeTruthy();
    expect(site.purchaseClicks).toBe(0);
  });

  it("stops with RESOLUTION_EXHAUSTED once the budget is spent", async () => {
    const agent = new ScriptedComputerUseAgent([{ type: "scroll", dx: 0, dy: 1 }, { type: "scroll", dx: 0, dy: 1 }, { type: "done", success: false }]);
    const { site, deps } = setup({ failDiscoverUntilAssisted: true }, { agent, resolverBudget: 2 });
    await expect(runSlowLane(req(), deps)).rejects.toBeInstanceOf(ResolutionExhaustedError);
    expect(site.purchaseClicks).toBe(0);
  });
});

describe("slow lane — already covered (§8)", () => {
  it("skips the purchase when the balance already clears the requirement", async () => {
    const { site, deps } = setup({ startingBalance: 10_000 });
    const result = await runSlowLane(req(), deps);
    expect(site.purchaseClicks).toBe(0);
    expect(result.alreadyCovered).toBe(true);
    expect(result.verifiedEntitlement.balance).toBe(10_000);
  });
});

describe("slow lane — liveness probe (§15.2)", () => {
  it("re-authenticates expired cookies before checkout", async () => {
    const { site, deps } = setup({ sessionExpired: true });
    await runSlowLane(req(), deps);
    expect(site.reauthCount).toBe(1);
    expect(site.purchaseClicks).toBe(1);
  });

  it("stops before checkout when re-authentication fails", async () => {
    const { site, deps } = setup({ sessionExpired: true, reauthFails: true });
    await expect(runSlowLane(req(), deps)).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    expect(site.purchaseClicks).toBe(0);
  });
});

describe("slow lane — HITL takeover (§15.11)", () => {
  it("hands the session to a human on a challenge, then verifies", async () => {
    let takeoverCalls = 0;
    const { site, deps, events } = setup({ require3dsOnceOnConfirm: true });
    deps.onTakeover = async () => {
      takeoverCalls += 1;
      site.takeoverCleared = true;
      site.balance += 5000;
    };
    const result = await runSlowLane(req(), deps);
    expect(takeoverCalls).toBe(1);
    expect(events).toContain("TAKEOVER_RESOLVED");
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });

  it("fails when a challenge appears and no takeover handler is provided", async () => {
    const { deps } = setup({ require3dsOnceOnConfirm: true });
    await expect(runSlowLane(req(), deps)).rejects.toBeTruthy();
  });
});

describe("slow lane — idempotency", () => {
  it("does not buy twice for the same requirement", async () => {
    const store = new InMemoryIdempotencyStore();
    const { site, deps } = setup({}, { store });
    const r = req();
    const first = await runSlowLane(r, deps);
    const second = await runSlowLane(r, deps);
    expect(site.purchaseClicks).toBe(1);
    expect(second.purchaseId).toBe(first.purchaseId);
  });
});

describe("chooseMinimumOffer", () => {
  it("picks the cheapest one-time offer that still satisfies the requirement", () => {
    const base = { currency: "USD", billing: "one_time" as const, autoRenew: false };
    const offers = [
      { productId: "a", label: "1k", unitsGranted: 1000, price: 5, ...base },
      { productId: "b", label: "5k", unitsGranted: 5000, price: 20, ...base },
      { productId: "s", label: "5k sub", unitsGranted: 5000, price: 10, ...base, billing: "subscription" as const },
    ];
    expect(chooseMinimumOffer(offers, { resource: "credits", amount: 3200 })?.productId).toBe("b");
    expect(chooseMinimumOffer(offers, { resource: "credits", amount: 500 })?.productId).toBe("a");
  });
});
