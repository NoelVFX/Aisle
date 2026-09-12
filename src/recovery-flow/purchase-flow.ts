import type { ApprovalDecision } from "./approval.js";

import type {
  PurchaseExecutor,
  PurchaseRequest,
  PurchaseResult,
} from "./purchase-executor.js";

import {
  PurchaseGuard,
} from "./purchase-guard.js";

/**
 * Execute a purchase only after customer approval
 * and purchase-guard validation.
 *
 * The guard prevents duplicate purchases for the same
 * task, provider, and plan.
 */
export async function executeApprovedPurchase(
  decision: ApprovalDecision,
  executor: PurchaseExecutor,
  guard: PurchaseGuard = new PurchaseGuard(),
): Promise<PurchaseResult> {
  /*
   * ---------------------------------------------------------
   * 1. Customer approval is mandatory
   * ---------------------------------------------------------
   */

  if (!decision.approved) {
    throw new Error(
      "Purchase cannot be executed without customer approval.",
    );
  }

  /*
   * ---------------------------------------------------------
   * 2. Build the purchase request
   * ---------------------------------------------------------
   */

  const request: PurchaseRequest = {
    taskId: decision.request.taskId,
    provider: decision.request.provider,
    plan: decision.request.plan,
  };

  const guardKey = {
    taskId: request.taskId,
    provider: request.provider,
    planId: request.plan.id,
  };

  /*
   * ---------------------------------------------------------
   * 3. Prevent duplicate purchases
   * ---------------------------------------------------------
   */

  const allowed = guard.acquire(guardKey);

  if (!allowed) {
    throw new Error(
      `Duplicate purchase blocked for task "${request.taskId}", provider "${request.provider}", and plan "${request.plan.id}".`,
    );
  }

  /*
   * ---------------------------------------------------------
   * 4. Execute the purchase
   * ---------------------------------------------------------
   */

  try {
    const result = await executor.purchase(request);

    /*
     * -------------------------------------------------------
     * 5. Handle explicit purchase failure
     * -------------------------------------------------------
     *
     * The provider explicitly confirmed that the purchase
     * did not happen, so the reservation can safely be
     * released and a future attempt may be allowed.
     */

    if (result.status === "FAILED") {
      guard.release(guardKey);

      return result;
    }

    /*
     * -------------------------------------------------------
     * 6. Handle unknown purchase result
     * -------------------------------------------------------
     *
     * We do not know whether the provider completed the
     * purchase. Keep the guard locked to prevent an unsafe
     * automatic duplicate purchase.
     */

    if (result.status === "UNKNOWN") {
      return result;
    }

    /*
     * -------------------------------------------------------
     * 7. Confirmed successful purchase
     * -------------------------------------------------------
     *
     * The guard reservation remains in place so the same
     * purchase cannot be executed again.
     */

    if (result.status === "SUCCESS") {
      return result;
    }

    /*
     * TypeScript should make this branch unreachable.
     */

    throw new Error(
      `Unsupported purchase status: ${result.status}`,
    );
  } catch (error) {
    /*
     * -------------------------------------------------------
     * 8. Executor exception
     * -------------------------------------------------------
     *
     * An exception does NOT automatically mean the purchase
     * failed. The provider may have received the request.
     *
     * Therefore, keep the guard reservation and rethrow.
     */

    throw error;
  }
}