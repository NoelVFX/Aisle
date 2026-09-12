/**
 * Mandate — sign, verify, and compare against the staged checkout
 * (aisle-pipeline.md §11, §18 Gate 1).
 *
 * - Single use: consumption is atomic and lives in the IdempotencyStore.
 * - Signed, and verified by the worker. The worker must not trust its own input.
 * - `maximumAmount` is a cap, not a price: `actual <= maximumAmount`, never `===`.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PurchaseMandate, Quote, StagedCheckout } from "../types.js";
import { canonicalJson } from "../core/hash.js";
import { MandateMismatchError, MandateRejectedError } from "../errors.js";

const DEFAULT_TTL_MS = 10 * 60_000;
/** Headroom for tax / FX on top of the quoted price. */
const DEFAULT_CAP_MULTIPLIER = 1.25;

export interface MandateKeyOptions {
  /** Defaults to process.env.MANDATE_SECRET, then a dev-only value. */
  secret?: string;
  now?: Date;
}

const secretOf = (opts?: MandateKeyOptions): string =>
  opts?.secret ?? process.env["MANDATE_SECRET"] ?? "dev-only-change-me";

function sign(unsigned: Omit<PurchaseMandate, "signature">, secret: string): string {
  return createHmac("sha256", secret).update(canonicalJson(unsigned)).digest("hex");
}

export interface SignMandateContext {
  taskId: string;
  recoveryJobId: string;
  userId: string;
}

export function signMandate(
  quote: Quote,
  ctx: SignMandateContext,
  opts: MandateKeyOptions & { ttlMs?: number; capMultiplier?: number } = {},
): PurchaseMandate {
  if (quote.billing !== "one_time" || quote.autoRenew !== false) {
    throw new MandateRejectedError("A recovery mandate can only authorize a one-time purchase with no auto-renew.");
  }
  const now = opts.now ?? new Date();
  const unsigned: Omit<PurchaseMandate, "signature"> = {
    mandateId: randomUUID(),
    taskId: ctx.taskId,
    recoveryJobId: ctx.recoveryJobId,
    userId: ctx.userId,
    provider: quote.provider,
    billingOrigin: quote.billingOrigin,
    productId: quote.productId,
    quantity: quote.quantity,
    unitsGranted: quote.unitsGranted,
    maximumAmount: Math.ceil(quote.price * (opts.capMultiplier ?? DEFAULT_CAP_MULTIPLIER) * 100) / 100,
    currency: quote.currency,
    billingType: "one_time",
    autoRenew: false,
    expiresAt: new Date(now.getTime() + (opts.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    nonce: randomBytes(16).toString("hex"),
  };
  return { ...unsigned, signature: sign(unsigned, secretOf(opts)) };
}

/** Throws `MandateRejectedError` unless the signature, expiry and terms are valid. */
export function verifyMandate(mandate: PurchaseMandate, opts: MandateKeyOptions = {}): void {
  const { signature, ...rest } = mandate;
  const expected = sign(rest, secretOf(opts));
  const a = Buffer.from(String(signature ?? ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new MandateRejectedError("Mandate signature is missing or invalid.", "MANDATE_SIGNATURE_INVALID");
  }
  const expiry = new Date(mandate.expiresAt).getTime();
  const now = (opts.now ?? new Date()).getTime();
  // An unparseable expiry (NaN) must fail closed, not pass as "not yet expired".
  if (!Number.isFinite(expiry) || expiry <= now) {
    throw new MandateRejectedError(`Mandate ${mandate.mandateId} has expired.`, "MANDATE_EXPIRED");
  }
  if (mandate.autoRenew !== false) {
    throw new MandateRejectedError("Mandate enables auto-renew.", "MANDATE_AUTORENEW_SET");
  }
  if (mandate.billingType !== "one_time") {
    throw new MandateRejectedError("Mandate is not one-time.", "MANDATE_NOT_ONE_TIME");
  }
  if (!Number.isFinite(mandate.maximumAmount) || mandate.maximumAmount <= 0) {
    throw new MandateRejectedError("Mandate maximum amount is invalid.", "MANDATE_INVALID_AMOUNT");
  }
}

/**
 * THE GATE THAT MAKES A WRONG CLICK SAFE (§18 Gate 1).
 * Called immediately before submit. Never after. Deterministic code only.
 */
export function assertMatchesMandate(staged: StagedCheckout, mandate: PurchaseMandate): void {
  if (!Number.isFinite(staged.amount) || staged.amount > mandate.maximumAmount) {
    throw new MandateMismatchError("AMOUNT_EXCEEDS_MANDATE", { staged: staged.amount, cap: mandate.maximumAmount });
  }
  if (staged.currency !== mandate.currency) {
    throw new MandateMismatchError("CURRENCY_MISMATCH", { staged: staged.currency, expected: mandate.currency });
  }
  if (staged.billingPeriod !== "one_time") {
    throw new MandateMismatchError("UNEXPECTED_SUBSCRIPTION", { staged: staged.billingPeriod });
  }
  if (staged.autoRenew !== false) {
    throw new MandateMismatchError("AUTO_RENEW_ENABLED", {});
  }
}
