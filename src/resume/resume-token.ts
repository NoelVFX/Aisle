/**
 * Resume token — the handoff artifact the host agent uses to continue the task
 * exactly where it stopped. It carries the ORIGINAL failed tool call so the
 * host replays it verbatim rather than regenerating a new request.
 */

import type { Entitlement, ResumeToken, TaskCheckpoint } from "../types.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function buildResumeToken(
  checkpoint: TaskCheckpoint,
  entitlement: Entitlement,
  quotedCredits: number,
  now: Date = new Date(),
): ResumeToken {
  return {
    // Deterministic id so re-issuing for the same failed call is idempotent.
    id: `resume:${checkpoint.taskId}:${checkpoint.failedToolCall.id}`,
    taskId: checkpoint.taskId,
    failedToolCallId: checkpoint.failedToolCall.id,
    resumeAction: {
      tool: checkpoint.failedToolCall.tool,
      arguments: checkpoint.failedToolCall.arguments,
    },
    entitlementRequirement: {
      provider: entitlement.provider,
      resource: entitlement.resource,
      minimumAmount: quotedCredits,
    },
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_MS).toISOString(),
  };
}

export function isResumeTokenExpired(token: ResumeToken, now: Date = new Date()): boolean {
  return new Date(token.expiresAt).getTime() <= now.getTime();
}
