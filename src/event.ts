export type FailureClassification =
  | "PAYMENT_REQUIRED"
  | "QUOTA_EXCEEDED"
  | "INSUFFICIENT_CREDITS"
  | "PLAN_REQUIRED"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "SERVER_ERROR"
  | "UNKNOWN";

export interface AgentContext {
  taskId: string;
  originalPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface FailureEvent {
  taskId: string;
  provider: string;
  toolName: string;
  toolArgs: unknown;
  errorType: FailureClassification;
  rawError: unknown;
  context: AgentContext;
  timestamp: string;
}