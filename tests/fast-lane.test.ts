import { describe, it, expect } from "vitest";
import { runFastLane } from "../src/fast-lane/executor.js";
import { MockWebMcpVendor } from "../src/mock/mock-vendor.js";
import {
  InMemoryIdempotencyStore,
  MandateRejectedError,
  NoFastLaneError,
  PurchaseVerificationError,
} from "../src/index.js";
import type { FastLaneRequest } from "../src/types.js";

const PROVIDER = "mock-image-api";
const ORIGIN = "https://api.mock-image-api.test";

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

describe("fast lane — happy path", () => {
  it("detects WebMCP, purchases, verifies, and issues a resume token", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const result = await runFastLane(makeRequest(), { session: vendor });

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
    await expect(runFastLane(makeRequest(), { session: vendor })).rejects.toBeInstanceOf(NoFastLaneError);
  });
});

describe("fast lane — guards", () => {
  it("rejects an origin-lock violation (purchase never happens)", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: "https://evil-site.test" });
    const req = makeRequest(); // mandate origin still points at the trusted origin
    await expect(runFastLane(req, { session: vendor })).rejects.toBeInstanceOf(MandateRejectedError);
    expect(vendor.purchaseCallCount).toBe(0);
  });

  it("rejects a price over the mandate ceiling", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const req = makeRequest();
    req.quote.purchase.price = 80; // mandate max is 50
    await expect(runFastLane(req, { session: vendor })).rejects.toBeInstanceOf(MandateRejectedError);
    expect(vendor.purchaseCallCount).toBe(0);
  });

  it("rejects an expired mandate", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const req = makeRequest();
    req.mandate.expiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(runFastLane(req, { session: vendor })).rejects.toBeInstanceOf(MandateRejectedError);
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
    await expect(runFastLane(makeRequest(), { session: vendor })).rejects.toBeInstanceOf(
      PurchaseVerificationError,
    );
  });
});

describe("fast lane — idempotency", () => {
  it("does not buy twice for the same requirement", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const store = new InMemoryIdempotencyStore();

    const first = await runFastLane(makeRequest(), { session: vendor, store });
    const second = await runFastLane(makeRequest(), { session: vendor, store });

    expect(vendor.purchaseCallCount).toBe(1);
    expect(second.purchaseId).toBe(first.purchaseId);
    expect(second.resumeToken.id).toBe(first.resumeToken.id);
  });
});
