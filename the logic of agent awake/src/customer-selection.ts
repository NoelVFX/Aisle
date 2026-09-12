import type { CreditPlan } from "./purchase-recommender.js";
import type { PurchaseRecommendation } from "./purchase-recommender.js";

export interface CustomerSelection {
  selectedPlan: CreditPlan;
  wasRecommended: boolean;
}

/**
 * Select one purchase plan chosen by the customer.
 *
 * The customer may choose the recommended plan or any
 * alternative plan presented by Aisle.
 */
export function selectPurchasePlan(
  recommendation: PurchaseRecommendation,
  selectedPlanId: string,
): CustomerSelection {
  const allPlans = [
    recommendation.recommended,
    ...recommendation.alternatives,
  ];

  const selectedPlan = allPlans.find(
    (plan) => plan.id === selectedPlanId,
  );

  if (!selectedPlan) {
    throw new Error(
      `Selected plan "${selectedPlanId}" is not available.`,
    );
  }

  return {
    selectedPlan,
    wasRecommended:
      selectedPlan.id === recommendation.recommended.id,
  };
}