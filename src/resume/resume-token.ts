/**
 * Resume record (aisle-pipeline.md §2.2, §19).
 *
 * The blocked tool call blocks; the agent never receives this. The gateway uses
 * `id` (= `resume:{taskId}:{failedToolCallId}`) as its idempotency key and
 * replays `resumeAction` with the EXACT same arguments object. Do not regenerate
 * the request. Do not "improve" the arguments.
 */

import type { Entitlement, ResumeToken, TaskCheckpoint } from "../types.js";
import { resumeKey } from "../core/hash.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function buildResumeToken(
  checkpoint: TaskCheckpoint,
  entitlement: Entitlement,
  minimumAmount: number,
  now: Date = new Date(),
): ResumeToken {
  return {
    id: resumeKey(checkpoint.taskId, checkpoint.toolCallId),
    taskId: checkpoint.taskId,
    failedToolCallId: checkpoint.toolCallId,
    resumeAction: {
      tool: checkpoint.tool,
      arguments: checkpoint.arguments,
    },
    entitlementRequirement: {
      provider: entitlement.provider,
      resource: entitlement.resource,
      minimumAmount,
    },
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_TTL_MS).toISOString(),
  };
}

export function isResumeTokenExpired(token: ResumeToken, now: Date = new Date()): boolean {
  const expiry = new Date(token.expiresAt).getTime();
  return !Number.isFinite(expiry) || expiry <= now.getTime();
}
