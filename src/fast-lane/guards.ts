/**
 * Pre-flight guards. These run BEFORE any purchase tool is called; every one
 * of them is a hard gate. The governing principle: a vendor (or any web
 * content) may *describe* a purchase, but only task configuration — expressed
 * through the signed mandate — can *authorize* one.
 */

import type { PurchaseMandate, Quote } from "../types.js";
import type { WebMcpSession } from "../webmcp/session.js";
import { MandateRejectedError } from "../errors.js";

/**
 * Verify the mandate signature. Stubbed for the demo (the signing authority is
 * owned by the approval/policy layer); swap in real verification before real
 * money moves.
 */
export function verifyMandateSignature(mandate: PurchaseMandate): boolean {
  return typeof mandate.signature === "string" && mandate.signature.length > 0;
}

export interface GuardContext {
  mandate: PurchaseMandate;
  quote: Quote;
  session: WebMcpSession;
  now?: Date;
}

/**
 * Assert every invariant required to safely execute the purchase. Throws
 * `MandateRejectedError` on the first violation.
 */
export function assertPurchaseAllowed(ctx: GuardContext): void {
  const { mandate, quote, session } = ctx;
  const now = ctx.now ?? new Date();

  if (!verifyMandateSignature(mandate)) {
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
