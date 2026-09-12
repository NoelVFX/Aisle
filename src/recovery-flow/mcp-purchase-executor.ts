import type {
  PurchaseExecutor,
  PurchaseRequest,
  PurchaseResult,
} from "./purchase-executor.js";

/**
 * Result returned by the real MCP purchase tool.
 */
export interface McpPurchaseResponse {
  status: "SUCCESS" | "FAILED" | "UNKNOWN";
  transactionId?: string;
  message?: string;
}

/**
 * Function used to call the real MCP purchase tool.
 */
export type McpPurchaseFunction = (
  request: PurchaseRequest,
) => Promise<McpPurchaseResponse>;

/**
 * PurchaseExecutor implementation for the Fast Lane.
 *
 * The real MCP implementation can later be connected here.
 */
export class McpPurchaseExecutor
  implements PurchaseExecutor
{
  private readonly purchaseCredits: McpPurchaseFunction;

  constructor(
    purchaseCredits: McpPurchaseFunction,
  ) {
    this.purchaseCredits = purchaseCredits;
  }

  async purchase(
    request: PurchaseRequest,
  ): Promise<PurchaseResult> {
    const result = await this.purchaseCredits(request);

    return {
      status: result.status,
      plan: request.plan,
      transactionId: result.transactionId,
      message:
        result.message ??
        this.createDefaultMessage(
          result.status,
          request.plan.credits,
        ),
    };
  }

  private createDefaultMessage(
    status: McpPurchaseResponse["status"],
    credits: number,
  ): string {
    switch (status) {
      case "SUCCESS":
        return `Successfully purchased ${credits} credits.`;

      case "FAILED":
        return "Purchase failed.";

      case "UNKNOWN":
        return "Purchase result is unknown.";
    }
  }
}