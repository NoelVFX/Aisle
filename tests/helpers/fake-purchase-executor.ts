import type {
  PurchaseExecutor,
  PurchaseRequest,
  PurchaseResult,
} from "../../src/recovery-flow/purchase-executor.js";

/**
 * A fake purchase executor used for testing.
 *
 * It does not perform any real payment.
 */
export class FakePurchaseExecutor
  implements PurchaseExecutor
{
  async purchase(
    request: PurchaseRequest,
  ): Promise<PurchaseResult> {
    return {
      status: "SUCCESS",
      plan: request.plan,
      transactionId: `mock-tx-${request.taskId}`,
      message: `Successfully purchased ${request.plan.credits} credits.`,
    };
  }
}