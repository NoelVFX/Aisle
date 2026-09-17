export type RecoverySessionStatus =
  | "RECOVERY_REQUIRED"
  | "PLAN_RECOMMENDED"
  | "CUSTOMER_SELECTED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "PURCHASING"
  | "PURCHASED"
  | "PURCHASE_FAILED"
  | "PURCHASE_UNKNOWN"
  | "ENTITLEMENT_UPDATED"
  | "READY_TO_RESUME"
  /**
   * Gateway extension: the checkout was staged and passed Gate 1, but real-money
   * submit is not enabled for this vendor. Nothing was charged. Terminal.
   */
  | "PURCHASE_WITHHELD";

export interface RecoverySession {
  taskId: string;
  status: RecoverySessionStatus;
}

/**
 * Create a new recovery session.
 */
export function createRecoverySession(
  taskId: string,
): RecoverySession {
  return {
    taskId,
    status: "RECOVERY_REQUIRED",
  };
}

/**
 * Move a recovery session to the next valid status.
 *
 * Invalid transitions are rejected so the recovery process
 * cannot skip safety-critical stages.
 */
export function transitionRecoverySession(
  session: RecoverySession,
  nextStatus: RecoverySessionStatus,
): RecoverySession {
  if (!isValidTransition(session.status, nextStatus)) {
    throw new Error(
      `Invalid recovery session transition: ${session.status} -> ${nextStatus}`,
    );
  }

  return {
    ...session,
    status: nextStatus,
  };
}

function isValidTransition(
  currentStatus: RecoverySessionStatus,
  nextStatus: RecoverySessionStatus,
): boolean {
  const transitions: Record<
    RecoverySessionStatus,
    RecoverySessionStatus[]
  > = {
    RECOVERY_REQUIRED: [
      "PLAN_RECOMMENDED",
    ],

    PLAN_RECOMMENDED: [
      "CUSTOMER_SELECTED",
    ],

    CUSTOMER_SELECTED: [
      "AWAITING_APPROVAL",
    ],

    AWAITING_APPROVAL: [
      "APPROVED",
      // Gateway extension: the customer may switch plans until they approve.
      // The mandate is re-signed for the new plan, so approval always binds the choice.
      "CUSTOMER_SELECTED",
    ],

    APPROVED: [
      "PURCHASING",
    ],

    PURCHASING: [
      "PURCHASED",
      "PURCHASE_FAILED",
      "PURCHASE_UNKNOWN",
      "PURCHASE_WITHHELD",
    ],

    PURCHASE_WITHHELD: [],

    PURCHASED: [
      "ENTITLEMENT_UPDATED",
    ],

    PURCHASE_FAILED: [],

    PURCHASE_UNKNOWN: [],

    ENTITLEMENT_UPDATED: [
      "READY_TO_RESUME",
    ],

    READY_TO_RESUME: [],
  };

  return transitions[currentStatus].includes(
    nextStatus,
  );
}