import type { CreditPlan } from "./purchase-recommender.js";

export interface ApprovalRequest {
  taskId: string;
  provider: string;
  plan: CreditPlan;
  reason: string;
}

export interface ApprovalDecision {
  approved: boolean;
  request: ApprovalRequest;
}

/**
 * Create a purchase approval request.
 *
 * This function does not perform any payment.
 */
export function createApprovalRequest(
  taskId: string,
  provider: string,
  plan: CreditPlan,
  requiredCredits: number,
): ApprovalRequest {
  return {
    taskId,
    provider,
    plan,
    reason: `The current task requires ${requiredCredits} additional credits.`,
  };
}

/**
 * Record the customer's approval decision.
 *
 * This function only records the decision.
 * It does not perform a purchase.
 */
export function recordApproval(
  request: ApprovalRequest,
  approved: boolean,
): ApprovalDecision {
  return {
    approved,
    request,
  };
}