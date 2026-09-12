import type { CreditPlan } from "./purchase-recommender.js";
import type { PurchaseResult } from "./purchase-executor.js";

export interface EntitlementState {
  credits: number;
}

/**
 * Apply a successful purchase to the current entitlement state.
 *
 * Only a confirmed SUCCESS purchase can increase credits.
 */
export function applyPurchaseToEntitlement(
  state: EntitlementState,
  purchaseResult: PurchaseResult,
): EntitlementState {
  if (purchaseResult.status !== "SUCCESS") {
    throw new Error(
      "Cannot update entitlement unless the purchase succeeded.",
    );
  }

  const plan: CreditPlan = purchaseResult.plan;

  return {
    credits: state.credits + plan.credits,
  };
}