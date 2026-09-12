import { describe, it, expect } from "vitest";
import { runFastLane } from "../src/fast-lane/executor.js";
import { signMandate } from "../src/fast-lane/guards.js";
import { purchaseKey, InMemoryIdempotencyStore } from "../src/fast-lane/idempotency.js";
import { MockWebMcpVendor } from "../src/mock/mock-vendor.js";
import {
  MandateRejectedError,
  NoFastLaneError,
  PurchaseInFlightError,
  PurchaseVerificationError,
} from "../src/index.js";
import type { FastLaneRequest, PurchaseMandate } from "../src/types.js";

const PROVIDER = "mock-image-api";
const ORIGIN = "https://api.mock-image-api.test";
const TEST_SECRET = "test-shared-secret";

function makeMandate(overrides: Partial<Omit<PurchaseMandate, "signature">> = {}): PurchaseMandate {
  const unsigned: Omit<PurchaseMandate, "signature"> = {
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
    ...overrides,
  };
  return { ...unsigned, signature: signMandate(unsigned, TEST_SECRET) };
}

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
    mandate: makeMandate(),
  };
  return { ...base, ...overrides };
}

function iso(): string {
  return new Date().toISOString();
}

describe("fast lane — happy path", () => {
  it("detects WebMCP, purchases, verifies, and issues a resume token", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const result = await runFastLane(makeRequest(), { session: vendor, mandateSecret: TEST_SECRET });

    expect(vendor.purchaseCallCount).toBe(1);
    expect(result.verifiedEntitlement.balance).toBe(5000);
    expect(result.resumeToken.failedToolCallId).toBe("call_2");
    // Original arguments replayed verbatim.
    expect(result.resumeToken.resumeAction).toEqual({
      tool: "generate_image",
      arguments: { prompt: "hero #2" },
    });
  });
});

describe("fast lane — routing", () => {
  it("throws NoFastLaneError when the vendor has no purchase tool", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, withoutPurchaseTool: true });
    await expect(
      runFastLane(makeRequest(), { session: vendor, mandateSecret: TEST_SECRET }),
    ).rejects.toBeInstanceOf(NoFastLaneError);
  });
});

describe("fast lane — guards", () => {
  it("rejects an origin-lock violation (purchase never happens)", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: "https://evil-site.test" });
    const req = makeRequest(); // mandate origin still points at the trusted origin
    await expect(
      runFastLane(req, { session: vendor, mandateSecret: TEST_SECRET }),
    ).rejects.toBeInstanceOf(MandateRejectedError);
    expect(vendor.purchaseCallCount).toBe(0);
  });

  it("rejects a price over the mandate ceiling", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const req = makeRequest();
    req.quote.purchase.price = 80; // mandate max is 50
    await expect(
      runFastLane(req, { session: vendor, mandateSecret: TEST_SECRET }),
    ).rejects.toBeInstanceOf(MandateRejectedError);
    expect(vendor.purchaseCallCount).toBe(0);
  });

  it("rejects an expired mandate", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const req = makeRequest({ mandate: makeMandate({ expiresAt: new Date(Date.now() - 1000).toISOString() }) });
    await expect(
      runFastLane(req, { session: vendor, mandateSecret: TEST_SECRET }),
    ).rejects.toBeInstanceOf(MandateRejectedError);
    expect(vendor.purchaseCallCount).toBe(0);
  });

  it("rejects a forged or tampered signature", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const req = makeRequest();
    req.mandate.signature = "00".repeat(32); // well-formed hex, wrong value
    await expect(
      runFastLane(req, { session: vendor, mandateSecret: TEST_SECRET }),
    ).rejects.toBeInstanceOf(MandateRejectedError);
    expect(vendor.purchaseCallCount).toBe(0);
  });

  it("rejects a mandate signed with the wrong secret", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const req = makeRequest();
    await expect(
      runFastLane(req, { session: vendor, mandateSecret: "not-the-real-secret" }),
    ).rejects.toBeInstanceOf(MandateRejectedError);
    expect(vendor.purchaseCallCount).toBe(0);
  });
});

describe("fast lane — verification", () => {
  it("fails when checkout succeeds but balance does not update", async () => {
    const vendor = new MockWebMcpVendor({
      provider: PROVIDER,
      origin: ORIGIN,
      startingBalance: 0,
      simulateBalanceNotUpdated: true,
    });
    await expect(
      runFastLane(makeRequest(), {
        session: vendor,
        mandateSecret: TEST_SECRET,
        verifyRetry: { attempts: 1, delayMsBetween: 0 }, // no need to wait out retries for a genuine failure
      }),
    ).rejects.toBeInstanceOf(PurchaseVerificationError);
  });

  it("retries balance verification for an eventually-consistent vendor", async () => {
    const vendor = new MockWebMcpVendor({
      provider: PROVIDER,
      origin: ORIGIN,
      startingBalance: 0,
      balanceVisibilityDelayReads: 2, // first two reads after purchase return the stale balance
    });
    const result = await runFastLane(makeRequest(), {
      session: vendor,
      mandateSecret: TEST_SECRET,
      verifyRetry: { attempts: 5, delayMsBetween: 0 },
    });
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });

  it("gives up after exhausting verification retries against a stale balance", async () => {
    const vendor = new MockWebMcpVendor({
      provider: PROVIDER,
      origin: ORIGIN,
      startingBalance: 0,
      balanceVisibilityDelayReads: 10,
    });
    await expect(
      runFastLane(makeRequest(), {
        session: vendor,
        mandateSecret: TEST_SECRET,
        verifyRetry: { attempts: 2, delayMsBetween: 0 },
      }),
    ).rejects.toBeInstanceOf(PurchaseVerificationError);
  });
});

describe("fast lane — ambiguous purchase failures", () => {
  it("recovers instead of double-buying when the purchase call fails but the vendor already processed it", async () => {
    const vendor = new MockWebMcpVendor({
      provider: PROVIDER,
      origin: ORIGIN,
      startingBalance: 0,
      simulateLostResponseOnPurchase: true, // vendor credits the account, then the call throws
    });
    const result = await runFastLane(makeRequest(), { session: vendor, mandateSecret: TEST_SECRET });

    expect(vendor.purchaseCallCount).toBe(1); // never retried — recovered from the same attempt
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });

  it("does not falsely recover when the purchase call fails and nothing was actually charged", async () => {
    const vendor = new MockWebMcpVendor({
      provider: PROVIDER,
      origin: ORIGIN,
      startingBalance: 0,
      simulateLostResponseOnPurchase: true,
      simulateBalanceNotUpdated: true, // genuinely never charged
    });
    await expect(
      runFastLane(makeRequest(), { session: vendor, mandateSecret: TEST_SECRET }),
    ).rejects.toThrow();
    expect(vendor.purchaseCallCount).toBe(1);
  });
});

describe("fast lane — idempotency", () => {
  it("does not buy twice for the same requirement", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const store = new InMemoryIdempotencyStore();

    const first = await runFastLane(makeRequest(), { session: vendor, mandateSecret: TEST_SECRET, store });
    const second = await runFastLane(makeRequest(), { session: vendor, mandateSecret: TEST_SECRET, store });

    expect(vendor.purchaseCallCount).toBe(1);
    expect(second.purchaseId).toBe(first.purchaseId);
    expect(second.resumeToken.id).toBe(first.resumeToken.id);
  });

  it("refuses to buy twice when an attempt for the same requirement is already in flight", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const store = new InMemoryIdempotencyStore();
    const req = makeRequest();

    // Simulate a first attempt that claimed the purchase but has not
    // finished (e.g. the host is still waiting on the vendor call).
    const key = purchaseKey(req.mandate, req.quote);
    await store.putIfAbsent({
      idempotencyKey: key,
      mandateId: req.mandate.mandateId,
      purchaseId: `pur_${req.mandate.mandateId}`,
      status: "PENDING",
    });

    await expect(
      runFastLane(req, { session: vendor, mandateSecret: TEST_SECRET, store }),
    ).rejects.toBeInstanceOf(PurchaseInFlightError);
    expect(vendor.purchaseCallCount).toBe(0);
  });

  it("refuses to resume on a stale COMPLETED record whose balance no longer covers the requirement", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const store = new InMemoryIdempotencyStore();
    const req = makeRequest();

    // A completed record exists, but the vendor's actual balance was never
    // this purchase's doing (or was spent since) — must not be trusted blind.
    const key = purchaseKey(req.mandate, req.quote);
    await store.putIfAbsent({
      idempotencyKey: key,
      mandateId: req.mandate.mandateId,
      purchaseId: `pur_${req.mandate.mandateId}`,
      status: "COMPLETED",
      transactionId: "txn_stale",
    });

    await expect(
      runFastLane(req, { session: vendor, mandateSecret: TEST_SECRET, store }),
    ).rejects.toBeInstanceOf(PurchaseVerificationError);
    expect(vendor.purchaseCallCount).toBe(0); // does not silently re-purchase either
  });

  it("retries after a prior attempt failed cleanly", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const store = new InMemoryIdempotencyStore();
    const req = makeRequest();

    const key = purchaseKey(req.mandate, req.quote);
    await store.putIfAbsent({
      idempotencyKey: key,
      mandateId: req.mandate.mandateId,
      purchaseId: `pur_${req.mandate.mandateId}`,
      status: "FAILED",
    });

    const result = await runFastLane(req, { session: vendor, mandateSecret: TEST_SECRET, store });
    expect(vendor.purchaseCallCount).toBe(1);
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });
});
