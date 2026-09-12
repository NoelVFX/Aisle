import { describe, it, expect } from "vitest";
import { runSlowLane } from "../src/slow-lane/executor.js";
import {
  MockBrowserProvider,
  MockVendorAdapter,
  MockVendorSite,
} from "../src/slow-lane/adapters/mock-vendor-site.js";
import { InMemoryProfileStore } from "../src/slow-lane/profiles.js";
import { ScriptedComputerUseAgent } from "../src/slow-lane/computer-use.js";
import { InMemoryIdempotencyStore } from "../src/fast-lane/idempotency.js";
import {
  MandateRejectedError,
  PurchaseVerificationError,
  chooseMinimumOffer,
} from "../src/index.js";
import type { FastLaneRequest } from "../src/types.js";

const PROVIDER = "mock-slow-vendor";
const ORIGIN = "https://shop.mock-slow-vendor.test";

function makeRequest(overrides: Partial<FastLaneRequest> = {}): FastLaneRequest {
  const base: FastLaneRequest = {
    checkpoint: {
      taskId: "task_1",
      agentId: "hermes",
      originalGoal: "Generate three hero images.",
      failedToolCall: { id: "call_2", tool: "generate_image", arguments: { prompt: "hero #2" } },
      origin: { provider: PROVIDER, canonicalOrigin: ORIGIN, source: "task_configuration", lockedAt: iso() },
      failure: { type: "INSUFFICIENT_CREDITS", rawError: { status: 402 } },
    },
    quote: {
      provider: PROVIDER,
      purchase: { productId: "credits_5000", quantity: 1, credits: 5000, price: 20, currency: "USD" },
      billing: "one_time",
      autoRenew: false,
      reason: "needs credits",
    },
    requirement: { resource: "credits", amount: 3200 },
    mandate: {
      mandateId: "mnd_1",
      taskId: "task_1",
      origin: ORIGIN,
      provider: PROVIDER,
      productId: "credits_5000",
      maximumAmount: 50,
      currency: "USD",
      billingType: "one_time",
      autoRenew: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: "nonce_1",
      signature: "sig_ok",
    },
  };
  return { ...base, ...overrides };
}

function iso(): string {
  return new Date().toISOString();
}

describe("slow lane — happy path", () => {
  it("navigates, purchases, verifies, saves a profile, and issues a resume token", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const profiles = new InMemoryProfileStore();
    const result = await runSlowLane(makeRequest(), {
      provider: new MockBrowserProvider(site),
      adapter: new MockVendorAdapter(site),
      profiles,
    });

    expect(result.lane).toBe("slow");
    expect(site.purchaseClicks).toBe(1);
    expect(result.verifiedEntitlement.balance).toBe(5000);
    expect(result.resumeToken.resumeAction).toEqual({
      tool: "generate_image",
      arguments: { prompt: "hero #2" },
    });
    expect(await profiles.load(PROVIDER)).toBeDefined();
  });
});

describe("slow lane — guards", () => {
  it("rejects an origin-lock violation before touching checkout", async () => {
    // Navigation to the authorized origin gets redirected to an attacker origin.
    const site = new MockVendorSite({
      provider: PROVIDER,
      origin: ORIGIN,
      redirectOrigin: "https://evil-shop.test",
    });
    const req = makeRequest(); // mandate still locked to the trusted origin
    await expect(
      runSlowLane(req, { provider: new MockBrowserProvider(site), adapter: new MockVendorAdapter(site) }),
    ).rejects.toBeInstanceOf(MandateRejectedError);
    expect(site.purchaseClicks).toBe(0);
  });
});

describe("slow lane — verification", () => {
  it("fails when checkout completes but credits never post", async () => {
    const site = new MockVendorSite({
      provider: PROVIDER,
      origin: ORIGIN,
      startingBalance: 0,
      dropCredits: true,
    });
    await expect(
      runSlowLane(makeRequest(), { provider: new MockBrowserProvider(site), adapter: new MockVendorAdapter(site) }),
    ).rejects.toBeInstanceOf(PurchaseVerificationError);
  });

  it("fails early (no purchase) when no offer can satisfy the requirement", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const req = makeRequest();
    req.requirement = { resource: "credits", amount: 999_999 };
    await expect(
      runSlowLane(req, { provider: new MockBrowserProvider(site), adapter: new MockVendorAdapter(site) }),
    ).rejects.toBeTruthy();
    expect(site.purchaseClicks).toBe(0);
  });
});

describe("slow lane — computer-use fallback", () => {
  it("recovers a failed deterministic step via the injected agent, then completes", async () => {
    const site = new MockVendorSite({
      provider: PROVIDER,
      origin: ORIGIN,
      startingBalance: 0,
      failDiscoverUntilAssisted: true,
    });
    // A click on the control surface unlocks discovery in the mock.
    const agent = new ScriptedComputerUseAgent([
      { type: "click", x: 100, y: 200 },
      { type: "done", success: true },
    ]);
    const result = await runSlowLane(makeRequest(), {
      provider: new MockBrowserProvider(site),
      adapter: new MockVendorAdapter(site),
      agent,
    });
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });

  it("fails without an agent when a deterministic step can't complete", async () => {
    const site = new MockVendorSite({
      provider: PROVIDER,
      origin: ORIGIN,
      failDiscoverUntilAssisted: true,
    });
    await expect(
      runSlowLane(makeRequest(), {
        provider: new MockBrowserProvider(site),
        adapter: new MockVendorAdapter(site),
      }),
    ).rejects.toBeTruthy();
    expect(site.purchaseClicks).toBe(0);
  });
});

describe("slow lane — already covered (§8)", () => {
  it("skips the purchase when the balance already clears the requirement", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 10_000 });
    const result = await runSlowLane(makeRequest(), {
      provider: new MockBrowserProvider(site),
      adapter: new MockVendorAdapter(site),
    });
    expect(site.purchaseClicks).toBe(0);
    expect(result.verifiedEntitlement.balance).toBe(10_000);
  });
});

describe("slow lane — verification is a delta (§17 Gate 2)", () => {
  it("fails when a pre-existing balance is present but the purchase adds nothing", async () => {
    // Start at 1000 (< requirement 3200 so it still buys), but credits never post.
    const site = new MockVendorSite({
      provider: PROVIDER,
      origin: ORIGIN,
      startingBalance: 1000,
      dropCredits: true,
    });
    // Absolute check (after >= requirement) would still fail here, but the point
    // is the delta: after (1000) is NOT >= before (1000) + granted (5000).
    await expect(
      runSlowLane(makeRequest(), { provider: new MockBrowserProvider(site), adapter: new MockVendorAdapter(site) }),
    ).rejects.toBeInstanceOf(PurchaseVerificationError);
  });
});

describe("slow lane — HITL takeover (§15.11 / 3-DS)", () => {
  it("hands the session to a human on a challenge, then completes", async () => {
    const site = new MockVendorSite({
      provider: PROVIDER,
      origin: ORIGIN,
      startingBalance: 0,
      require3dsOnceOnConfirm: true,
    });
    let takeoverCalls = 0;
    const result = await runSlowLane(makeRequest(), {
      provider: new MockBrowserProvider(site),
      adapter: new MockVendorAdapter(site),
      onTakeover: async () => {
        takeoverCalls += 1;
        // Human clears 3-DS and the checkout completes → credits post.
        site.takeoverCleared = true;
        site.balance += 5000;
      },
    });
    expect(takeoverCalls).toBe(1);
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });

  it("fails when a challenge appears and no takeover handler is provided", async () => {
    const site = new MockVendorSite({
      provider: PROVIDER,
      origin: ORIGIN,
      require3dsOnceOnConfirm: true,
    });
    await expect(
      runSlowLane(makeRequest(), { provider: new MockBrowserProvider(site), adapter: new MockVendorAdapter(site) }),
    ).rejects.toBeTruthy();
  });
});

describe("slow lane — idempotency", () => {
  it("does not buy twice for the same requirement", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const store = new InMemoryIdempotencyStore();
    const deps = {
      provider: new MockBrowserProvider(site),
      adapter: new MockVendorAdapter(site),
      store,
    };
    const first = await runSlowLane(makeRequest(), deps);
    const second = await runSlowLane(makeRequest(), deps);
    expect(site.purchaseClicks).toBe(1);
    expect(second.purchaseId).toBe(first.purchaseId);
  });
});

describe("chooseMinimumOffer", () => {
  it("picks the cheapest offer that still satisfies the requirement", () => {
    const offers = [
      { productId: "a", label: "1k", units: 1000, price: 5, currency: "USD", billing: "one_time" as const },
      { productId: "b", label: "5k", units: 5000, price: 20, currency: "USD", billing: "one_time" as const },
    ];
    expect(chooseMinimumOffer(offers, { resource: "credits", amount: 3200 })?.productId).toBe("b");
    expect(chooseMinimumOffer(offers, { resource: "credits", amount: 500 })?.productId).toBe("a");
  });
});
