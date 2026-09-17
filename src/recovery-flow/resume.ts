import type { FailureEvent } from "../event.js";
import type { PurchaseResult } from "./purchase-executor.js";
import type { EntitlementState } from "./entitlement.js";

export interface ResumeRequest {
  taskId: string;
  originalPrompt?: string;
  purchase: PurchaseResult;
  entitlement: EntitlementState;
}

export interface ResumeResult {
  resumed: boolean;
  taskId: string;
  message: string;
}

/**
 * Create a request for the original agent to resume its task.
 *
 * This function does not actually execute the original agent.
 * It only creates the information required for resumption.
 */
export function createResumeRequest(
  event: FailureEvent,
  purchase: PurchaseResult,
  entitlement: EntitlementState,
): ResumeRequest {
  return {
    taskId: event.taskId,
    originalPrompt: event.context.originalPrompt,
    purchase,
    entitlement,
  };
}

/**
 * Mark the original task as ready to resume.
 *
 * Actual agent execution can be connected later.
 */
export function createResumeResult(
  request: ResumeRequest,
): ResumeResult {
  return {
    resumed: true,
    taskId: request.taskId,
    message:
      "Purchase completed and credits restored. The original task can resume.",
  };
}