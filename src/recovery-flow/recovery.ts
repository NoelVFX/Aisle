import type { FailureEvent } from "../event.js";

import {
  calculateRequiredCredits,
  recommendCreditPlan,
  type CreditPlan,
  type PurchaseRecommendation,
} from "./purchase-recommender.js";

export interface RecoveryContext {
  currentCredits: number;
  taskRequiredCredits: number;
  availablePlans: CreditPlan[];
}

export interface RecoveryResult {
  event: FailureEvent;
  requiredCredits: number;
  recommendation?: PurchaseRecommendation;
}

export function createRecoveryDecision(
  event: FailureEvent,
  context: RecoveryContext,
): RecoveryResult {
  const requiredCredits = calculateRequiredCredits(
    context.taskRequiredCredits,
    context.currentCredits,
  );

  if (requiredCredits === 0) {
    return {
      event,
      requiredCredits: 0,
    };
  }

  const recommendation = recommendCreditPlan({
    requiredCredits,
    plans: context.availablePlans,
  });

  return {
    event,
    requiredCredits,
    recommendation,
  };
}