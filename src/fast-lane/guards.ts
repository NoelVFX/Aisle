/**
 * Pre-flight guards. These run BEFORE any purchase tool is called; every one
 * of them is a hard gate. The governing principle: a vendor (or any web
 * content) may *describe* a purchase, but only task configuration — expressed
 * through the signed mandate — can *authorize* one.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PurchaseMandate, Quote } from "../types.js";
import type { WebMcpSession } from "../webmcp/session.js";
import { MandateRejectedError } from "../errors.js";

type UnsignedMandate = Omit<PurchaseMandate, "signature">;

/**
 * Canonical, explicit representation of everything the mandate authorizes.
 * Signing/verifying over this fixed field list — never `JSON.stringify(mandate)`
 * directly — means key order can't matter and a field added to `PurchaseMandate`
 * later doesn't silently become part of the signed surface (or silently drop
 * out of it) without a deliberate change here.
 */
function mandateSigningPayload(mandate: UnsignedMandate): string {
  return JSON.stringify({
    mandateId: mandate.mandateId,
    taskId: mandate.taskId,
    origin: mandate.origin,
    provider: mandate.provider,
    productId: mandate.productId,
    maximumAmount: mandate.maximumAmount,
    currency: mandate.currency,
    billingType: mandate.billingType,
    autoRenew: mandate.autoRenew,
    expiresAt: mandate.expiresAt,
    nonce: mandate.nonce,
  });
}

/**
 * Sign a mandate. Called by the approval/policy layer that owns the secret —
 * NOT by anything in the purchase path. Exported so the host has a reference
 * implementation that is guaranteed to match `verifyMandateSignature` below;
 * swap for asymmetric signing if the signer and verifier must not share a key.
 */
export function signMandate(mandate: UnsignedMandate, secret: string): string {
  return createHmac("sha256", secret).update(mandateSigningPayload(mandate)).digest("hex");
}

/**
 * Verify the mandate signature against the same shared secret the approval
 * layer signed it with. Constant-time comparison so a mismatch can't be
 * timed to leak how many leading bytes were correct.
 */
export function verifyMandateSignature(mandate: PurchaseMandate, secret: string): boolean {
  if (typeof mandate.signature !== "string" || mandate.signature.length === 0) return false;

  const expected = Buffer.from(signMandate(mandate, secret), "hex");
  let actual: Buffer;
  try {
    actual = Buffer.from(mandate.signature, "hex");
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export interface GuardContext {
  mandate: PurchaseMandate;
  quote: Quote;
  session: WebMcpSession;
  /** Shared secret the approval layer used to sign the mandate. */
  mandateSecret: string;
  now?: Date;
}

/**
 * Assert every invariant required to safely execute the purchase. Throws
 * `MandateRejectedError` on the first violation.
 */
export function assertPurchaseAllowed(ctx: GuardContext): void {
  const { mandate, quote, session, mandateSecret } = ctx;
  const now = ctx.now ?? new Date();

  if (!verifyMandateSignature(mandate, mandateSecret)) {
    throw new MandateRejectedError("Mandate signature is missing or invalid.");
  }

  if (new Date(mandate.expiresAt).getTime() <= now.getTime()) {
    throw new MandateRejectedError(`Mandate ${mandate.mandateId} has expired.`);
  }

  // Origin lock: the WebMCP session must be connected to the exact origin the
  // task authorized. Never trust an origin that came from tool output or a page.
  if (normalizeOrigin(session.origin) !== normalizeOrigin(mandate.origin)) {
    throw new MandateRejectedError(
      `Origin lock violation: session origin '${session.origin}' != mandate origin '${mandate.origin}'.`,
    );
  }

  if (mandate.provider !== quote.provider || mandate.provider !== session.provider) {
    throw new MandateRejectedError("Provider mismatch between mandate, quote, and session.");
  }

  if (mandate.productId !== quote.purchase.productId) {
    throw new MandateRejectedError("Mandate productId does not match the quoted product.");
  }

  // Per-purchase ceiling: the quoted price must not exceed what was authorized.
  if (quote.purchase.price > mandate.maximumAmount) {
    throw new MandateRejectedError(
      `Quoted price ${quote.purchase.price} exceeds mandate maximum ${mandate.maximumAmount}.`,
    );
  }

  if (quote.purchase.currency !== mandate.currency) {
    throw new MandateRejectedError("Currency mismatch between quote and mandate.");
  }

  if (mandate.autoRenew !== false || quote.autoRenew !== false) {
    throw new MandateRejectedError("Auto-renew is not permitted for a recovery purchase.");
  }
}

/** Lowercase + strip a trailing slash so origin comparison is stable. */
export function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, "");
}
