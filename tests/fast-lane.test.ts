import { describe, it, expect } from "vitest";
import { runFastLane } from "../src/fast-lane/executor.js";
import { MockWebMcpVendor } from "../src/mock/mock-vendor.js";
import {
  InMemoryIdempotencyStore,
  MandateRejectedError,
  NoFastLaneError,
  PurchaseVerificationError,
} from "../src/index.js";
import { makeRequest, SECRET } from "./fixtures.js";

const PROVIDER = "mock-image-api";
const ORIGIN = "https://api.mock-image-api.test";
const req = (o: Partial<Parameters<typeof makeRequest>[0]> = {}) => makeRequest({ provider: PROVIDER, origin: ORIGIN, ...o });
const deps = (session: MockWebMcpVendor, extra: Record<string, unknown> = {}) => ({ session, mandateSecret: SECRET, ...extra });

describe("fast lane — happy path", () => {
  it("detects purchase tools, buys, verifies by delta, and builds the resume record", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const result = await runFastLane(req(), deps(vendor));

    expect(vendor.chargeCount).toBe(1);
    expect(result.alreadyCovered).toBe(false);
    expect(result.verifiedEntitlement.balance).toBe(5000);
    expect(result.resumeToken.id).toBe("resume:task_1:call_2");
    expect(result.resumeToken.resumeAction).toEqual({ tool: "generate_image", arguments: { prompt: "hero #2" } });
  });

  it("sends only mandate-derived snake_case args with the purchase idempotency key", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const calls: Array<Record<string, unknown>> = [];
    const original = vendor.callTool.bind(vendor);
    vendor.callTool = async (name, args) => {
      if (name === "purchase_credits") calls.push(args);
      return original(name, args);
    };
    await runFastLane(req(), deps(vendor));
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(["idempotency_key", "product_id", "quantity"]);
    expect(String(calls[0]?.["idempotency_key"])).toMatch(/^purchase:task_1:[0-9a-f]{64}$/);
  });
});

describe("fast lane — routing", () => {
  it("throws NoFastLaneError when the vendor has no purchase tool", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, withoutPurchaseTool: true });
    await expect(runFastLane(req(), deps(vendor))).rejects.toBeInstanceOf(NoFastLaneError);
  });
});

describe("fast lane — entitlement check (§8)", () => {
  it("does not buy when the balance already covers the requirement", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, startingBalance: 4000 });
    const result = await runFastLane(req(), deps(vendor));
    expect(vendor.purchaseCallCount).toBe(0);
    expect(result.alreadyCovered).toBe(true);
    expect(result.purchaseId).toBeNull();
  });
});

describe("fast lane — guards", () => {
  it("rejects an origin-lock violation (purchase never happens)", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: "https://evil-site.test" });
    await expect(runFastLane(req(), deps(vendor))).rejects.toBeInstanceOf(MandateRejectedError);
    expect(vendor.purchaseCallCount).toBe(0);
  });

  it("treats default ports and case as the same origin (canonicalize, not ===)", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: "HTTPS://API.mock-image-api.test:443/" });
    const result = await runFastLane(req(), deps(vendor));
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });

  it("rejects a quoted price over the mandate cap", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const r = req();
    r.quote.price = 80;
    await expect(runFastLane(r, deps(vendor))).rejects.toBeInstanceOf(MandateRejectedError);
    expect(vendor.purchaseCallCount).toBe(0);
  });

  it("rejects an expired mandate", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const r = req({ signedAt: new Date(Date.now() - 60 * 60_000) });
    await expect(runFastLane(r, deps(vendor))).rejects.toMatchObject({ code: "MANDATE_EXPIRED" });
    expect(vendor.purchaseCallCount).toBe(0);
  });

  it("rejects a tampered mandate (HMAC signature)", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const r = req();
    r.mandate.maximumAmount = 5000;
    await expect(runFastLane(r, deps(vendor))).rejects.toMatchObject({ code: "MANDATE_SIGNATURE_INVALID" });
    expect(vendor.purchaseCallCount).toBe(0);
  });
});

describe("fast lane — verification", () => {
  it("fails when checkout succeeds but the balance does not move", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, simulateBalanceNotUpdated: true });
    await expect(runFastLane(req(), deps(vendor))).rejects.toBeInstanceOf(PurchaseVerificationError);
  });

  it("never issues a resume record on retry after a failed verification", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, simulateBalanceNotUpdated: true });
    const store = new InMemoryIdempotencyStore();
    const r = req();
    await expect(runFastLane(r, deps(vendor, { store }))).rejects.toBeInstanceOf(PurchaseVerificationError);
    // Same (consumed) mandate: refused. Nothing is re-bought and no token issued.
    await expect(runFastLane(r, deps(vendor, { store }))).rejects.toMatchObject({ code: "MANDATE_ALREADY_USED" });
    expect(vendor.chargeCount).toBe(1);
  });

  it("response lost after charge → verifies by observation, never retries", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN, loseResponseAfterCharge: true });
    const events: string[] = [];
    const result = await runFastLane(req(), deps(vendor, { emit: (e: { type: string }) => events.push(e.type) }));
    expect(events).toContain("PURCHASE_RESULT_UNKNOWN");
    expect(vendor.chargeCount).toBe(1);
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });
});

describe("fast lane — idempotency", () => {
  it("does not buy twice for the same requirement", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const store = new InMemoryIdempotencyStore();
    const r = req();
    const first = await runFastLane(r, deps(vendor, { store }));
    const second = await runFastLane(r, deps(vendor, { store }));
    expect(vendor.purchaseCallCount).toBe(1);
    expect(second.purchaseId).toBe(first.purchaseId);
    expect(second.resumeToken.id).toBe(first.resumeToken.id);
  });

  it("a second mandate for the same shortfall joins the first purchase", async () => {
    const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: ORIGIN });
    const store = new InMemoryIdempotencyStore();
    await runFastLane(req(), deps(vendor, { store }));
    await runFastLane(req(), deps(vendor, { store }));
    expect(vendor.chargeCount).toBe(1);
  });
});
