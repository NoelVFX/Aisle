import type {
  PurchaseExecutor,
  PurchaseRequest,
  PurchaseResult,
} from "./purchase-executor.js";

/**
 * A fake purchase executor used for testing.
 *
 * It does not perform any real payment.
 */
export class MockPurchaseExecutor
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