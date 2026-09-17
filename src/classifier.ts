/**
 * Blocker classifier (aisle-pipeline.md §6, web-path.md §3).
 *
 * ONE classifier, TWO transports. Order:
 *   1. The 429 guard — Retry-After < 60s is a rate limit, not a wall. Keep it first.
 *   2. Vendor rules for the provider.
 *   3. Explicit payment/credit codes and messages.
 *   4. Generic HTTP status rules.
 *   5. UNKNOWN — the error passes through untouched.
 */

import type { Blocker, BlockerType } from "./types.js";
import type { FailureClassification } from "./event.js";
import { normalizeError, type NormalizedError } from "./error-normalizer.js";

export interface ClassifiedFailure {
  classification: FailureClassification;
  recoverable: boolean;
  reason: string;
  /** Shared blocker shape. `type` is UNKNOWN for anything that isn't a billing wall. */
  blocker: Blocker;
}

/** Blocker types that open a recovery job. */
export const RECOVERABLE_BLOCKERS: ReadonlySet<FailureClassification> = new Set<BlockerType>([
  "INSUFFICIENT_CREDITS",
  "QUOTA_EXCEEDED",
  "PLAN_REQUIRED",
  "SEAT_REQUIRED",
  "PAYMENT_REQUIRED",
]);

export interface VendorRule {
  test: (e: NormalizedError) => boolean;
  type: BlockerType;
  resource: string;
  required?: (e: NormalizedError) => number | undefined;
}

const bodyField = (e: NormalizedError, key: string): unknown =>
  e.body !== null && typeof e.body === "object" ? (e.body as Record<string, unknown>)[key] : undefined;

const numberField = (e: NormalizedError, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const v = bodyField(e, key);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
};

const VENDOR_RULES = new Map<string, VendorRule[]>([
  [
    "mockvendor",
    [
      {
        test: (e) => e.code?.toLowerCase() === "insufficient_credits",
        type: "INSUFFICIENT_CREDITS",
        resource: "image_credits",
        required: (e) => numberField(e, "required_credits"),
      },
    ],
  ],
  [
    "openrouter",
    [
      {
        // ⚠ VERIFY against a real drained key and tighten (web-path.md §8).
        test: (e) => e.status === 402 || /credit|balance/i.test(e.message ?? ""),
        type: "INSUFFICIENT_CREDITS",
        resource: "usd_balance",
      },
    ],
  ],
]);

/** Add or replace the rules for a vendor. Vendor rules run before generic ones. */
export function registerVendorRules(provider: string, rules: VendorRule[]): void {
  VENDOR_RULES.set(provider, rules);
}

/** THE 429 GUARD. A rate limit is not a billing wall. */
export function isRateLimitNotWall(status: number | undefined, retryAfterSeconds: number | undefined): boolean {
  return status === 429 && retryAfterSeconds !== undefined && retryAfterSeconds < 60;
}

export interface ClassifyOptions {
  /** Upstream namespace from config, e.g. "mockvendor". Selects vendor rules. */
  provider?: string;
  /** false on the web path when the response body was evicted → low confidence. */
  bodyAvailable?: boolean;
}

export function classifyFailure(error: unknown, opts: ClassifyOptions = {}): ClassifiedFailure {
  return classifyNormalizedError(normalizeError(error), opts);
}

function classifyNormalizedError(error: NormalizedError, opts: ClassifyOptions): ClassifiedFailure {
  const confidence: Blocker["confidence"] = opts.bodyAvailable === false ? "low" : "high";
  const status = error.status;
  const code = error.code?.toLowerCase() ?? "";
  const message = error.message?.toLowerCase() ?? "";
  const text = `${code} ${message}`;
  const required = numberField(error, "required_credits", "required", "credits_required", "required_amount");

  const wall = (type: BlockerType, resource: string, reason: string, req = required): ClassifiedFailure => {
    const blocker: Blocker = { type, resource, confidence, raw: error.raw };
    if (req !== undefined) blocker.required = req;
    return { classification: type, recoverable: true, reason, blocker };
  };
  const pass = (classification: FailureClassification, reason: string): ClassifiedFailure => ({
    classification,
    recoverable: false,
    reason,
    blocker: { type: "UNKNOWN", resource: "unknown", confidence, raw: error.raw },
  });

  // 1. The 429 guard comes before everything, including explicit quota codes.
  if (isRateLimitNotWall(status, error.retryAfterSeconds)) {
    return pass("RATE_LIMITED", `Rate limited (Retry-After ${error.retryAfterSeconds}s). Sleep and retry; do not buy.`);
  }

  // 2. Vendor rules.
  if (opts.provider) {
    for (const rule of VENDOR_RULES.get(opts.provider) ?? []) {
      if (!rule.test(error)) continue;
      return wall(rule.type, rule.resource, `Matched ${opts.provider} vendor rule.`, rule.required?.(error) ?? required);
    }
  }

  // 3. Explicit codes and messages.
  if (code === "insufficient_credits" || code === "credits_exhausted" || /insufficient[ _]credits/.test(message)) {
    return wall("INSUFFICIENT_CREDITS", "credits", "The provider reported that the account does not have enough credits.");
  }
  if (code === "quota_exceeded" || message.includes("quota exceeded")) {
    return wall("QUOTA_EXCEEDED", "quota", "The provider reported that the account has exceeded its usage quota.");
  }
  if (code === "seat_required" || code === "seats_exhausted") {
    return wall("SEAT_REQUIRED", "seats", "The operation requires an additional seat.");
  }
  if (
    code === "plan_required" ||
    code === "requires_paid_plan" ||
    message.includes("plan required") ||
    message.includes("paid plan")
  ) {
    return wall("PLAN_REQUIRED", "plan", "The requested operation requires a paid plan.");
  }

  // 4. Generic HTTP status rules.
  if (status === 402 || message.includes("payment required")) {
    return wall("PAYMENT_REQUIRED", "unknown", "The provider returned a payment-required response.");
  }
  if (
    status === 401 ||
    code === "unauthorized" ||
    code === "authentication_required" ||
    message.includes("unauthorized") ||
    message.includes("authentication required")
  ) {
    return pass("AUTH_REQUIRED", "The request requires authentication rather than payment.");
  }
  if (status === 403) {
    if (/seat/.test(text)) return wall("SEAT_REQUIRED", "seats", "403 indicating a seat limit.");
    if (/plan|upgrade|subscription/.test(text)) return wall("PLAN_REQUIRED", "plan", "403 indicating a plan upgrade.");
    return pass("FORBIDDEN", "The authenticated user does not have permission to perform this operation.");
  }
  if (code === "forbidden" || message.includes("forbidden")) {
    return pass("FORBIDDEN", "The authenticated user does not have permission to perform this operation.");
  }
  if (status === 429 && /quota|limit|exceed/.test(text)) {
    return wall("QUOTA_EXCEEDED", "quota", "429 indicating quota exhaustion.");
  }
  if (status === 404 || code === "not_found" || message.includes("not found")) {
    return pass("NOT_FOUND", "The requested resource was not found.");
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return pass("SERVER_ERROR", "The provider returned a server-side failure.");
  }

  // 5. Ordinary error — pass it through untouched.
  return pass("UNKNOWN", "The error could not be identified as a recoverable payment failure.");
}
