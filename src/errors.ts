/** Typed errors so the host agent can branch on recovery outcomes. */

import type { StagedCheckout } from "./types.js";

export class FastLaneError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Fast lane isn't viable (no purchase tools) — route to the slow lane. */
export class NoFastLaneError extends FastLaneError {
  constructor(message: string) {
    super(message, "NO_FAST_LANE");
  }
}

/** A pre-flight guard rejected the purchase before any money moved. */
export class MandateRejectedError extends FastLaneError {
  constructor(message: string, code = "MANDATE_REJECTED") {
    super(message, code);
  }
}

/**
 * §18 Gate 1: the staged checkout does not match the signed mandate.
 * `reason` is one of AMOUNT_EXCEEDS_MANDATE | CURRENCY_MISMATCH |
 * UNEXPECTED_SUBSCRIPTION | AUTO_RENEW_ENABLED. Always raised BEFORE submit.
 */
export class MandateMismatchError extends MandateRejectedError {
  constructor(
    readonly reason: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(`MANDATE_MISMATCH:${reason}`, "MANDATE_MISMATCH");
  }
}

/** The vendor explicitly reported a failure; no money moved. */
export class PurchaseFailedError extends FastLaneError {
  constructor(message: string, code = "PURCHASE_FAILED") {
    super(message, code);
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

/** §16.6: the resolver budget for this job is spent. Never falls back to "try clicking things". */
export class ResolutionExhaustedError extends FastLaneError {
  constructor(message: string) {
    super(message, "RESOLUTION_EXHAUSTED");
  }
}

/**
 * §16.5: Aisle's OWN resolver credits are exhausted. The recovery layer cannot
 * recover itself. Fail loud; this must never open a recovery job.
 */
export class InfraBlockedError extends FastLaneError {
  constructor(message = "Resolver credits exhausted. Aisle cannot recover its own resolver. Top up manually.") {
    super(message, "INFRA_BLOCKED");
  }
}

/**
 * The checkout was staged and passed Gate 1, but real-money submit is not
 * enabled for this vendor (aisle-pipeline.md §27). Nothing was submitted and the
 * mandate was not consumed.
 */
export class SubmitWithheldError extends FastLaneError {
  constructor(
    message: string,
    readonly staged: StagedCheckout,
  ) {
    super(message, "SUBMIT_WITHHELD");
  }
}
