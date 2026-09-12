/**
 * Pre-flight guards, shared by both lanes. Every one is a hard gate that runs
 * BEFORE any purchase tool is called or any checkout is touched.
 *
 * A vendor (or any web content) may *describe* a purchase; only task
 * configuration — frozen into the checkpoint and bound by the signed mandate —
 * can *authorize* one.
 */

import type { PurchaseMandate, Quote, TaskCheckpoint } from "../types.js";
import { MandateRejectedError } from "../errors.js";
import { verifyMandate } from "../mandate/mandate.js";
import { canonicalize, sameOrigin } from "../policy/policy.js";

export interface GuardContext {
  checkpoint: TaskCheckpoint;
  mandate: PurchaseMandate;
  quote: Quote;
  /**
   * The origin we are ACTUALLY about to transact against: the purchase-tool
   * session's origin (fast lane) or the browser's current page origin (slow lane).
   */
  actualOrigin: string;
  /** Provider of the live connection (session / browser). */
  actualProvider: string;
  /**
   * Fast lane may transact on the upstream API origin or the billing origin
   * (native MCP tool vs WebMCP on the billing page, §13). The slow lane only
   * ever spends on the billing origin.
   */
  lane: "fast" | "slow";
  now?: Date;
  /** HMAC secret; defaults to process.env.MANDATE_SECRET. */
  mandateSecret?: string;
}

const reject = (message: string, code = "MANDATE_REJECTED"): never => {
  throw new MandateRejectedError(message, code);
};

export function assertPurchaseAllowed(ctx: GuardContext): void {
  const { checkpoint, mandate, quote, actualOrigin, actualProvider, lane } = ctx;

  // Signature, expiry (NaN fails closed), one_time, no auto-renew.
  verifyMandate(mandate, {
    ...(ctx.mandateSecret === undefined ? {} : { secret: ctx.mandateSecret }),
    ...(ctx.now === undefined ? {} : { now: ctx.now }),
  });

  const locked = checkpoint.origin;

  // Origin lock. The anchor is the checkpoint's config-locked origin, never the
  // mandate's or quote's own claim, and never anything a vendor returned.
  if (!sameOrigin(mandate.billingOrigin, locked.billingOrigin)) {
    reject(
      `Origin lock violation: mandate billing origin '${mandate.billingOrigin}' is not the task-authorized ` +
        `'${locked.billingOrigin}'.`,
      "ORIGIN_VIOLATION",
    );
  }
  if (!sameOrigin(quote.billingOrigin, locked.billingOrigin)) {
    reject(`Origin lock violation: quote billing origin '${quote.billingOrigin}' is not authorized.`, "ORIGIN_VIOLATION");
  }
  const allowed = lane === "fast" ? [locked.canonicalOrigin, locked.billingOrigin] : [locked.billingOrigin];
  if (!allowed.some((o) => sameOrigin(actualOrigin, o))) {
    reject(
      `Origin lock violation: actual origin '${actualOrigin}' is not in the authorized set ` +
        `[${allowed.join(", ")}].`,
      "ORIGIN_VIOLATION",
    );
  }

  if (mandate.taskId !== checkpoint.taskId) {
    reject("Mandate was issued for a different task.");
  }
  if (
    mandate.provider !== quote.provider ||
    mandate.provider !== locked.provider ||
    mandate.provider !== actualProvider
  ) {
    reject("Provider mismatch between mandate, quote, checkpoint, and connection.");
  }
  if (mandate.productId !== quote.productId || mandate.quantity !== quote.quantity) {
    reject("Mandate product/quantity does not match the quote.");
  }
  if (mandate.unitsGranted !== quote.unitsGranted) {
    reject("Mandate units do not match the quote.");
  }

  // Cap, not price: quote.price <= maximumAmount. NaN fails closed.
  if (!Number.isFinite(quote.price) || quote.price < 0 || quote.price > mandate.maximumAmount) {
    reject(`Quoted price ${quote.price} exceeds mandate maximum ${mandate.maximumAmount}.`, "AMOUNT_EXCEEDS_MANDATE");
  }
  if (quote.currency !== mandate.currency) {
    reject("Currency mismatch between quote and mandate.", "CURRENCY_MISMATCH");
  }
  if (quote.billing !== "one_time") {
    reject("A recovery purchase must be one-time.", "UNEXPECTED_SUBSCRIPTION");
  }
  if (quote.autoRenew !== false) {
    reject("Auto-renew is not permitted for a recovery purchase.", "AUTO_RENEW_ENABLED");
  }
}

/** @deprecated Use `canonicalize` from the policy module. */
export const normalizeOrigin = canonicalize;
