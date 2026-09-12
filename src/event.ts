import type { Blocker, BlockerType, LockedOrigin } from "./types.js";

/**
 * The wake-up layer's classification. Walls use the shared `BlockerType`
 * (aisle-pipeline.md §6); the extra non-wall categories exist for logging only
 * and all map to `blocker.type === "UNKNOWN"` — ordinary errors pass through untouched.
 */
export type FailureClassification =
  | BlockerType
  /** 429 with Retry-After < 60s. Sleep and retry. Buying credits does not fix it. */
  | "RATE_LIMITED"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "SERVER_ERROR";

export interface AgentContext {
  taskId: string;
  /** null/undefined on CLI paths — you don't get it, don't fake it. */
  originalPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface FailureEvent {
  taskId: string;
  /** Stable id of the blocked call (resume:{taskId}:{toolCallId}). */
  toolCallId?: string;
  provider: string;
  toolName: string;
  /** The EXACT arguments of the blocked call. */
  toolArgs: unknown;
  errorType: FailureClassification;
  /** Structured blocker for the recovery layer (resource, required amount, confidence). */
  blocker?: Blocker;
  /** Origin locked from configuration at interception time — never from the error. */
  origin?: LockedOrigin;
  /**
   * sha256 of the API key the failing call used. Lets the wake-up manager
   * refuse to recover Aisle's own infrastructure key (§16.5).
   */
  credentialFingerprint?: string;
  rawError: unknown;
  context: AgentContext;
  timestamp: string;
}
