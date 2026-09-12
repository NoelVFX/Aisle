/**
 * Quote engine (aisle-pipeline.md §9).
 *
 *   minimize  price
 *   subject to  balance_after >= required
 *               price <= per_purchase_ceiling
 *               purchase.origin == checkpoint.origin.billingOrigin
 *
 * "What is the minimum entitlement required to finish this task?" — NOT
 * "what can I buy?". Returns null when nothing viable exists; the caller turns
 * that into a NO_VIABLE_OFFER refusal (or ALREADY_COVERED when shortfall is 0).
 */

import type { Entitlement, PurchaseOffer, Quote, TaskCheckpoint } from "../types.js";

export interface BuildQuoteInput {
  checkpoint: TaskCheckpoint;
  /** Freshly re-read entitlement (the ledger is a cache, never truth). */
  current: Entitlement | null;
  offers: PurchaseOffer[];
  perPurchaseCeiling: number;
  /** e.g. "3 hero images" — prefixed to the user-facing reason. */
  contextNote?: string;
}

export type QuoteOutcome =
  | { kind: "ALREADY_COVERED"; balance: number; required: number }
  | { kind: "NO_VIABLE_OFFER"; balance: number; required: number; shortfall: number }
  | { kind: "QUOTE"; quote: Quote };

const fmt = (n: number): string => n.toLocaleString("en-US");

export function buildQuote(input: BuildQuoteInput): QuoteOutcome {
  const { checkpoint, current, offers, perPurchaseCeiling } = input;
  const balance = current?.balance ?? 0;
  const required = checkpoint.blocker.required ?? 1;
  const shortfall = Math.max(0, required - balance);
  if (shortfall === 0) return { kind: "ALREADY_COVERED", balance, required };

  const viable = offers
    .filter((o) => Number.isFinite(o.price) && Number.isFinite(o.unitsGranted))
    .filter((o) => o.unitsGranted >= shortfall)
    // A wildly oversized minimum package is a refusal, not a quote.
    .filter((o) => o.price <= perPurchaseCeiling)
    // autoRenew: false always. An offer that can't be configured that way is not quotable.
    .filter((o) => o.autoRenew === false)
    // Prefer one_time even when a subscription is cheaper per unit:
    // the user is unblocking a task, not adopting a vendor.
    .sort((a, b) => (a.billing === b.billing ? a.price - b.price : a.billing === "one_time" ? -1 : 1));

  const best = viable[0];
  if (!best || best.billing !== "one_time") {
    return { kind: "NO_VIABLE_OFFER", balance, required, shortfall };
  }

  const what = input.contextNote ? `${input.contextNote} ` : "";
  const reason =
    `${what}needs ${fmt(required)} ${checkpoint.blocker.resource}. Balance ${fmt(balance)}. ` +
    `Smallest package that clears the ${fmt(shortfall)} shortfall is ${best.label} at $${best.price}.`;

  return {
    kind: "QUOTE",
    quote: {
      provider: checkpoint.origin.provider,
      billingOrigin: checkpoint.origin.billingOrigin,
      productId: best.productId,
      quantity: 1,
      unitsGranted: best.unitsGranted,
      price: best.price,
      currency: best.currency,
      billing: "one_time",
      autoRenew: false,
      reason,
    },
  };
}
