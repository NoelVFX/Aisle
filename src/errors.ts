/** Typed errors so the host agent can branch on recovery outcomes. */

export class FastLaneError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Fast lane isn't viable (no WebMCP tools) — host should try the slow lane. */
export class NoFastLaneError extends FastLaneError {
  constructor(message: string) {
    super(message, "NO_FAST_LANE");
  }
}

/** A pre-flight guard rejected the purchase before any money moved. */
export class MandateRejectedError extends FastLaneError {
  constructor(message: string) {
    super(message, "MANDATE_REJECTED");
  }
}

/** The vendor's purchase tool reported a failure. */
export class PurchaseFailedError extends FastLaneError {
  constructor(message: string) {
    super(message, "PURCHASE_FAILED");
  }
}

/** Checkout "succeeded" but the balance did not reflect the expected entitlement. */
export class PurchaseVerificationError extends FastLaneError {
  constructor(message: string) {
    super(message, "PURCHASE_VERIFICATION_FAILED");
  }
}

/**
 * The checkout hit a challenge the automation must not clear on its own — 3-DS,
 * an OTP, a bank verification step. The worker hands the live session to a human
 * (Steel HITL takeover) rather than failing or faking it.
 */
export class TakeoverRequiredError extends FastLaneError {
  constructor(message: string) {
    super(message, "TAKEOVER_REQUIRED");
  }
}
