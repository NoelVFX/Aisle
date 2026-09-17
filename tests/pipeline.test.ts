/** Spec behaviours added to match docs/aisle-pipeline.md §6–§11 and §25. */

import { describe, it, expect } from "vitest";
import {
  argumentsHash,
  buildQuote,
  canonicalize,
  classifyFailure,
  ErrorInterceptor,
  fingerprintKey,
  gate,
  InfraBlockedError,
  requirementHash,
  signMandate,
  verifyMandate,
  WakeUpManager,
  type FailureEvent,
  type Limits,
  type PurchaseOffer,
} from "../src/index.js";
import { makeRequest, SECRET } from "./fixtures.js";

const LIMITS: Limits = { perPurchase: 50, perTask: 100, perDay: 250, maxAttemptsPerTask: 3, maxResolverCallsPerJob: 5 };

describe("classifier (§6)", () => {
  it("429 with Retry-After < 60 is a rate limit — never a wall, even with a quota code", () => {
    const r = classifyFailure({ status: 429, code: "quota_exceeded", headers: { "Retry-After": "10" } });
    expect(r.classification).toBe("RATE_LIMITED");
    expect(r.recoverable).toBe(false);
    expect(r.blocker.type).toBe("UNKNOWN");
  });

  it("429 with a long Retry-After and a quota code is a quota wall", () => {
    expect(classifyFailure({ status: 429, code: "quota_exceeded", retryAfter: 3600 }).classification).toBe("QUOTA_EXCEEDED");
  });

  it("403 mentioning an upgrade is PLAN_REQUIRED; seats is SEAT_REQUIRED; bare 403 is FORBIDDEN", () => {
    expect(classifyFailure({ status: 403, message: "Upgrade your subscription" }).classification).toBe("PLAN_REQUIRED");
    expect(classifyFailure({ status: 403, message: "No seats left" }).classification).toBe("SEAT_REQUIRED");
    expect(classifyFailure({ status: 403, error: "Forbidden" }).classification).toBe("FORBIDDEN");
  });

  it("applies vendor rules first and parses the required amount", () => {
    const r = classifyFailure({ status: 402, code: "insufficient_credits", required_credits: 1067 }, { provider: "mockvendor" });
    expect(r.blocker).toMatchObject({ type: "INSUFFICIENT_CREDITS", resource: "image_credits", required: 1067, confidence: "high" });
  });

  it("classifies the gateway error envelope and an OpenRouter-shaped body", () => {
    const r = classifyFailure({ isError: true, status: 402, error: { error: "x", message: "Insufficient credits" } }, { provider: "openrouter" });
    expect(r.blocker.resource).toBe("usd_balance");
  });

  it("marks low confidence when the body was unavailable", () => {
    expect(classifyFailure({ status: 402 }, { bodyAvailable: false }).blocker.confidence).toBe("low");
  });
});

describe("wake-up manager", () => {
  const event = (over: Partial<FailureEvent> = {}): FailureEvent => ({
    taskId: "t",
    provider: "openrouter",
    toolName: "chat",
    toolArgs: {},
    errorType: "INSUFFICIENT_CREDITS",
    rawError: {},
    context: { taskId: "t" },
    timestamp: new Date().toISOString(),
    ...over,
  });

  it("never opens a recovery for Aisle's own infra key (§16.5)", async () => {
    let woke = 0;
    let flagged = 0;
    const m = new WakeUpManager(
      { wake: async () => void (woke += 1) },
      { nonRecoverableKeyFingerprints: [fingerprintKey("infra")], onInfraBlocked: () => void (flagged += 1), log: () => {} },
    );
    await expect(m.handle(event({ credentialFingerprint: fingerprintKey("infra") }))).rejects.toBeInstanceOf(InfraBlockedError);
    expect(woke).toBe(0);
    expect(flagged).toBe(1);
    await m.handle(event({ credentialFingerprint: fingerprintKey("demo-vendor-key") }));
    expect(woke).toBe(1);
  });

  it("the same shortfall from two different tools joins one recovery", async () => {
    let woke = 0;
    const m = new WakeUpManager({ wake: async () => void (woke += 1) }, { log: () => {} });
    await m.handle(event({ toolName: "a" }));
    await m.handle(event({ toolName: "b" }));
    expect(woke).toBe(1);
  });

  it("wakes again after markResolved", async () => {
    let woke = 0;
    const m = new WakeUpManager({ wake: async () => void (woke += 1) }, { log: () => {} });
    const e = event();
    await m.handle(e);
    m.markResolved(e);
    await m.handle(e);
    expect(woke).toBe(2);
  });

  it("the interceptor passes the vendor's blocker through to the handler", async () => {
    let received: FailureEvent | undefined;
    const i = new ErrorInterceptor(new WakeUpManager({ wake: async (e) => void (received = e) }, { log: () => {} }));
    await i.handleError(
      { taskId: "t", provider: "mockvendor", toolName: "generate_image", toolArgs: { n: 1 }, context: { taskId: "t" } },
      { status: 402, code: "insufficient_credits", required_credits: 1067 },
    );
    expect(received?.blocker?.required).toBe(1067);
  });
});

describe("hashing (§7, §20)", () => {
  it("argumentsHash is independent of key order, including nested keys", () => {
    expect(argumentsHash({ a: 1, b: { d: 2, c: 3 } })).toBe(argumentsHash({ b: { c: 3, d: 2 }, a: 1 }));
    expect(argumentsHash({ a: { x: 1 } })).not.toBe(argumentsHash({ a: { x: 2 } }));
  });
  it("requirementHash is sha256 hex", () => {
    expect(requirementHash("p", "credits", 3200)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("origin canonicalization (§10)", () => {
  it("normalizes scheme case, host case, default port, path and trailing slash", () => {
    expect(canonicalize("HTTPS://Example.com:443/billing/")).toBe("https://example.com");
    expect(canonicalize("http://localhost:8080/")).toBe("http://localhost:8080");
    expect(() => canonicalize("not a url")).toThrow();
  });
});

describe("quote engine (§9)", () => {
  const offer = (o: Partial<PurchaseOffer>): PurchaseOffer => ({
    productId: "x", label: "x", unitsGranted: 5000, price: 20, currency: "USD", billing: "one_time", autoRenew: false, ...o,
  });

  it("returns ALREADY_COVERED when the balance clears the requirement", () => {
    const { checkpoint } = makeRequest({ provider: "p", origin: "https://p.test", required: 3200 });
    const out = buildQuote({ checkpoint, current: balance(4000), offers: [offer({})], perPurchaseCeiling: 50 });
    expect(out.kind).toBe("ALREADY_COVERED");
  });

  it("prefers one_time over a cheaper subscription and never quotes auto-renew", () => {
    const { checkpoint } = makeRequest({ provider: "p", origin: "https://p.test", required: 3200 });
    const out = buildQuote({
      checkpoint,
      current: balance(0),
      offers: [offer({ productId: "sub", price: 10, billing: "subscription" }), offer({ productId: "one", price: 20 }), offer({ productId: "ar", price: 15, autoRenew: true })],
      perPurchaseCeiling: 50,
    });
    expect(out.kind === "QUOTE" && out.quote.productId).toBe("one");
    expect(out.kind === "QUOTE" && out.quote.billingOrigin).toBe("https://p.test");
  });

  it("refuses when the smallest viable package is over the ceiling", () => {
    const { checkpoint } = makeRequest({ provider: "p", origin: "https://p.test", required: 3200 });
    const out = buildQuote({ checkpoint, current: balance(0), offers: [offer({ unitsGranted: 100_000, price: 400 })], perPurchaseCeiling: 50 });
    expect(out.kind).toBe("NO_VIABLE_OFFER");
  });

  function balance(b: number) {
    return { userId: "u", provider: "p", accountId: null, resource: "credits", balance: b, plan: null, seatsUsed: null, seatsTotal: null, status: "active" as const, verifiedAt: new Date().toISOString() };
  }
});

describe("policy gate (§10)", () => {
  const base = () => makeRequest({ provider: "p", origin: "https://p.test" });

  it("refuses a poisoned origin first, reporting attempted and authorized", () => {
    const { quote, checkpoint } = base();
    const r = gate({ ...quote, billingOrigin: "https://evil-example.com" }, checkpoint, { task: 0, day: 0, attempts: 0 }, LIMITS);
    expect(r).toMatchObject({ ok: false, reason: "ORIGIN_VIOLATION", detail: { attempted: "https://evil-example.com", authorized: "https://p.test" } });
  });

  it("per-task refusal always reports cumulative spend", () => {
    const { quote, checkpoint } = base();
    const r = gate({ ...quote, price: 30 }, checkpoint, { task: 80, day: 80, attempts: 1 }, LIMITS);
    expect(r).toMatchObject({ ok: false, reason: "PER_TASK_CEILING", detail: { cumulative: 80, requested: 30, remaining: 20 } });
  });

  it("per-purchase, per-day and circuit breaker", () => {
    const { quote, checkpoint } = base();
    expect(gate({ ...quote, price: 60 }, checkpoint, { task: 0, day: 0, attempts: 0 }, LIMITS)).toMatchObject({ reason: "PER_PURCHASE_CEILING" });
    expect(gate(quote, checkpoint, { task: 0, day: 240, attempts: 0 }, LIMITS)).toMatchObject({ reason: "PER_DAY_CEILING" });
    expect(gate(quote, checkpoint, { task: 0, day: 0, attempts: 3 }, LIMITS)).toMatchObject({ reason: "CIRCUIT_OPEN" });
    expect(gate(quote, checkpoint, { task: 0, day: 0, attempts: 0 }, LIMITS)).toEqual({ ok: true });
  });
});

describe("mandate (§11)", () => {
  it("caps above the price for tax and verifies its own signature", () => {
    const { quote } = makeRequest({ provider: "p", origin: "https://p.test" });
    const m = signMandate(quote, { taskId: "t", recoveryJobId: "j", userId: "u" }, { secret: SECRET });
    expect(m.maximumAmount).toBe(25);
    expect(() => verifyMandate(m, { secret: SECRET })).not.toThrow();
    expect(() => verifyMandate(m, { secret: "other" })).toThrow(/signature/);
    expect(() => verifyMandate({ ...m, expiresAt: "tomorrow" }, { secret: SECRET })).toThrow();
  });

  it("refuses to sign a subscription", () => {
    const { quote } = makeRequest({ provider: "p", origin: "https://p.test" });
    expect(() => signMandate({ ...quote, billing: "subscription" }, { taskId: "t", recoveryJobId: "j", userId: "u" })).toThrow();
  });
});
