import type { FailureEvent } from "../event.js";

import {
  createRecoveryDecision,
  type RecoveryContext,
} from "./recovery.js";

import {
  selectPurchasePlan,
  type CustomerSelection,
} from "./customer-selection.js";

import {
  createApprovalRequest,
  recordApproval,
  type ApprovalDecision,
} from "./approval.js";

import {
  executeApprovedPurchase,
} from "./purchase-flow.js";

import type {
  PurchaseExecutor,
  PurchaseResult,
} from "./purchase-executor.js";

import {
  applyPurchaseToEntitlement,
  type EntitlementState,
} from "./entitlement.js";

import {
  createResumeRequest,
  createResumeResult,
  type ResumeResult,
} from "./resume.js";

import {
  createRecoverySession,
  transitionRecoverySession,
  type RecoverySession,
} from "./recovery-session.js";

export interface RecoveryOrchestratorInput {
  event: FailureEvent;
  recoveryContext: RecoveryContext;

  /**
   * The plan selected by the customer.
   */
  selectedPlanId: string;

  /**
   * Whether the customer approved the selected purchase.
   */
  approved: boolean;

  /**
   * Executor responsible for the actual purchase.
   */
  purchaseExecutor: PurchaseExecutor;

  /**
   * Current entitlement state.
   */
  entitlement: EntitlementState;
}

export interface RecoveryOrchestratorResult {
  session: RecoverySession;

  recommendation: ReturnType<
    typeof createRecoveryDecision
  >;

  selection?: CustomerSelection;

  approval?: ApprovalDecision;

  purchase?: PurchaseResult;

  entitlement?: EntitlementState;

  resume?: ResumeResult;
}

export async function executeRecovery(
  input: RecoveryOrchestratorInput,
): Promise<RecoveryOrchestratorResult> {
  /*
   * ---------------------------------------------------------
   * 1. Start recovery session
   * ---------------------------------------------------------
   */

  let session = createRecoverySession(
    input.event.taskId,
  );

  /*
   * ---------------------------------------------------------
   * 2. Create recovery decision
   * ---------------------------------------------------------
   */

  const recommendation = createRecoveryDecision(
    input.event,
    input.recoveryContext,
  );

  /*
   * ---------------------------------------------------------
   * 3. No purchase is required
   * ---------------------------------------------------------
   */

  if (!recommendation.recommendation) {
    return {
      session,
      recommendation,
    };
  }

  session = transitionRecoverySession(
    session,
    "PLAN_RECOMMENDED",
  );

  /*
   * ---------------------------------------------------------
   * 4. Customer selects a plan
   * ---------------------------------------------------------
   */

  const selection = selectPurchasePlan(
    recommendation.recommendation,
    input.selectedPlanId,
  );

  session = transitionRecoverySession(
    session,
    "CUSTOMER_SELECTED",
  );

  /*
   * ---------------------------------------------------------
   * 5. Create approval request
   * ---------------------------------------------------------
   */

  const approvalRequest = createApprovalRequest(
    input.event.taskId,
    input.event.provider,
    selection.selectedPlan,
    recommendation.requiredCredits,
  );

  session = transitionRecoverySession(
    session,
    "AWAITING_APPROVAL",
  );

  /*
   * ---------------------------------------------------------
   * 6. Record customer decision
   * ---------------------------------------------------------
   */

  const approval = recordApproval(
    approvalRequest,
    input.approved,
  );

  /*
   * ---------------------------------------------------------
   * 7. Stop if customer rejects
   * ---------------------------------------------------------
   */

  if (!approval.approved) {
    return {
      session,
      recommendation,
      selection,
      approval,
    };
  }

  session = transitionRecoverySession(
    session,
    "APPROVED",
  );

  /*
   * ---------------------------------------------------------
   * 8. Start purchasing
   * ---------------------------------------------------------
   */

  session = transitionRecoverySession(
    session,
    "PURCHASING",
  );

  /*
   * ---------------------------------------------------------
   * 9. Execute approved purchase
   * ---------------------------------------------------------
   */

  const purchase = await executeApprovedPurchase(
    approval,
    input.purchaseExecutor,
  );

  /*
   * ---------------------------------------------------------
   * 10. Handle purchase failure
   * ---------------------------------------------------------
   */

  if (purchase.status === "FAILED") {
    session = transitionRecoverySession(
      session,
      "PURCHASE_FAILED",
    );

    return {
      session,
      recommendation,
      selection,
      approval,
      purchase,
    };
  }

  /*
   * ---------------------------------------------------------
   * 11. Handle unknown purchase result
   * ---------------------------------------------------------
   */

  if (purchase.status === "UNKNOWN") {
    session = transitionRecoverySession(
      session,
      "PURCHASE_UNKNOWN",
    );

    return {
      session,
      recommendation,
      selection,
      approval,
      purchase,
    };
  }

  /*
   * ---------------------------------------------------------
   * 12. Mark purchase successful
   * ---------------------------------------------------------
   */

  session = transitionRecoverySession(
    session,
    "PURCHASED",
  );

  /*
   * ---------------------------------------------------------
   * 13. Update entitlement
   * ---------------------------------------------------------
   */

  const entitlement = applyPurchaseToEntitlement(
    input.entitlement,
    purchase,
  );

  session = transitionRecoverySession(
    session,
    "ENTITLEMENT_UPDATED",
  );

  /*
   * ---------------------------------------------------------
   * 14. Create resume request
   * ---------------------------------------------------------
   */

  const resumeRequest = createResumeRequest(
    input.event,
    purchase,
    entitlement,
  );

  /*
   * ---------------------------------------------------------
   * 15. Mark original task ready to resume
   * ---------------------------------------------------------
   */

  const resume = createResumeResult(
    resumeRequest,
  );

  session = transitionRecoverySession(
    session,
    "READY_TO_RESUME",
  );

  return {
    session,
    recommendation,
    selection,
    approval,
    purchase,
    entitlement,
    resume,
  };
}