/**
 * Vendor purchase adapters.
 *
 * There is no single browser agent that "figures out" every checkout. Each
 * vendor gets a small adapter that knows the site's predictable mechanics:
 * where pricing lives, how to stage a checkout, how to confirm, and how to read
 * the balance back. The worker orchestrates; the adapter knows the vendor.
 *
 * Adapter methods should use the deterministic `PageLike` path. When a step
 * genuinely can't be completed deterministically they throw
 * `DeterministicStepError`; the worker then (optionally) hands that sub-goal to
 * the computer-use agent and retries the read once.
 */

import type { PageLike } from "./browser.js";
import type {
  PurchaseOffer,
  PurchaseVerification,
  Requirement,
  StagedPurchase,
} from "../types.js";

export interface VendorPurchaseAdapter {
  readonly provider: string;

  /** True if this adapter handles the given (already origin-locked) URL. */
  canHandle(url: string): boolean;

  /** Navigate to pricing and read the purchasable packages. */
  discoverOffers(page: PageLike, requirement: Requirement): Promise<PurchaseOffer[]>;

  /** Bring a chosen offer up to the confirmation step — do NOT confirm yet. */
  stagePurchase(page: PageLike, offer: PurchaseOffer): Promise<StagedPurchase>;

  /** Click the final confirm control. Returns what the page reports. */
  confirmPurchase(page: PageLike, staged: StagedPurchase): Promise<PurchaseVerification>;

  /**
   * Re-read authoritative account state (balance/plan). Used both to verify a
   * completed purchase and to resolve an UNKNOWN result without re-buying.
   */
  verifyEntitlement(page: PageLike, requirement: Requirement): Promise<PurchaseVerification>;
}

/** Raised by an adapter when a deterministic step can't find what it needs. */
export class DeterministicStepError extends Error {
  constructor(
    message: string,
    /** An instruction the computer-use agent can act on to recover this step. */
    readonly recoveryInstruction: string,
  ) {
    super(message);
    this.name = "DeterministicStepError";
  }
}

/**
 * Choose the cheapest offer that still satisfies the requirement. This is the
 * "buy the minimum" principle: optimize for task completion, not vendor revenue.
 */
export function chooseMinimumOffer(
  offers: PurchaseOffer[],
  requirement: Requirement,
): PurchaseOffer | undefined {
  return offers
    .filter((o) => o.units >= requirement.amount)
    .sort((a, b) => a.price - b.price)[0];
}
