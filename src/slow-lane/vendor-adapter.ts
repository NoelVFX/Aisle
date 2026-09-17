/**
 * Vendor purchase adapters (build-checklist Phase 5, aisle-pipeline.md §17).
 *
 * The worker orchestrates; the adapter knows the vendor. Adapter methods use the
 * deterministic `PageLike` path. When a READ or STAGING step can't be completed
 * deterministically they throw `DeterministicStepError`, and the worker may hand
 * that sub-goal to the computer-use resolver. The final submit is never handed
 * to a model (§16.1): `confirmPurchase` failures are never recovered by the agent.
 */

import type { PageLike } from "./browser.js";
import type {
  PurchaseMandate,
  PurchaseOffer,
  PurchaseVerification,
  Requirement,
  StagedPurchase,
} from "../types.js";

export interface VendorPurchaseAdapter {
  readonly provider: string;

  /** True if this adapter handles the given (already origin-locked) URL. */
  canHandle(url: string): boolean;

  /**
   * Liveness probe before checkout (§15.2). Return true when logged in, after
   * attempting re-authentication (Steel Credentials API) if needed.
   * Discovering you're logged out at the card step is the worst place to find out.
   */
  ensureLoggedIn?(page: PageLike): Promise<boolean>;

  /**
   * True while this URL is the vendor's sign-in wall (or an SSO host off the
   * billing origin). Must not navigate: it is polled while a human signs in
   * during a takeover (steel.md §16.3).
   */
  onLoginWall?(url: string): boolean;

  /**
   * After a takeover for a checkout challenge (3-D Secure, OTP): true once the
   * challenge is gone. Reads the page only; never clicks or navigates.
   */
  challengeCleared?(page: PageLike): Promise<boolean>;

  /** Navigate to pricing and read the purchasable packages. */
  discoverOffers(page: PageLike, requirement: Requirement): Promise<PurchaseOffer[]>;

  /**
   * Bring a chosen offer up to the confirmation step — do NOT confirm. Must read
   * back the staged line item, amount, currency, billing period and auto-renew
   * flag from the checkout page for the Gate 1 comparison.
   */
  stagePurchase(page: PageLike, offer: PurchaseOffer): Promise<StagedPurchase>;

  /**
   * Click the final confirm control. Deterministic code only. Throw
   * `DeterministicStepError` ONLY when nothing was clicked (control not found).
   */
  confirmPurchase(page: PageLike, staged: StagedPurchase): Promise<PurchaseVerification>;

  /**
   * Re-read authoritative account state. Used before buying (ALREADY_COVERED,
   * Gate 2 baseline), after buying, and to resolve an UNKNOWN result without
   * re-buying.
   */
  verifyEntitlement(page: PageLike, requirement: Requirement): Promise<PurchaseVerification>;
}

/** Raised by an adapter when a deterministic step can't find what it needs. */
export class DeterministicStepError extends Error {
  constructor(
    message: string,
    /** An instruction the computer-use resolver can act on to recover this step. */
    readonly recoveryInstruction: string,
  ) {
    super(message);
    this.name = "DeterministicStepError";
  }
}

const quotable = (o: PurchaseOffer): boolean =>
  o.billing === "one_time" && o.autoRenew === false && Number.isFinite(o.price) && Number.isFinite(o.unitsGranted);

/**
 * The cheapest one-time, non-renewing offer that still satisfies the
 * requirement — "buy the minimum": optimize for task completion, not vendor revenue.
 */
export function chooseMinimumOffer(offers: PurchaseOffer[], requirement: Requirement): PurchaseOffer | undefined {
  return offers
    .filter(quotable)
    .filter((o) => o.unitsGranted >= requirement.amount)
    .sort((a, b) => a.price - b.price)[0];
}

/**
 * Pick the offer to actually buy. Prefers the mandate's exact product (adapters
 * that read real product ids), otherwise the cheapest offer that satisfies the
 * requirement (generic adapters that synthesize ids). Either way the executor
 * re-checks price against the quote and the mandate cap before staging.
 */
export function selectOffer(
  offers: PurchaseOffer[],
  mandate: Pick<PurchaseMandate, "productId">,
  requirement: Requirement,
): PurchaseOffer | undefined {
  const exact = offers.find((o) => o.productId === mandate.productId);
  if (exact && quotable(exact) && exact.unitsGranted >= requirement.amount) return exact;
  return chooseMinimumOffer(offers, requirement);
}
