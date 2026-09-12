import type { CreditPlan } from "./purchase-recommender.js";

export type PurchaseStatus =
  | "SUCCESS"
  | "FAILED"
  | "UNKNOWN";

export interface PurchaseRequest {
  taskId: string;
  provider: string;
  plan: CreditPlan;
}

export interface PurchaseResult {
  status: PurchaseStatus;
  plan: CreditPlan;
  transactionId?: string;
  message: string;
}

export interface PurchaseExecutor {
  purchase(
    request: PurchaseRequest,
  ): Promise<PurchaseResult>;
}