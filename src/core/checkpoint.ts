/**
 * Checkpoint freeze (aisle-pipeline.md §2.3, §7).
 *
 * The origin is captured at checkpoint time, from YOUR OWN CONFIG. By the time
 * anything hostile could suggest a URL, the authorized origin is already frozen.
 */

import type { Blocker, LockedOrigin, Requirement, TaskCheckpoint } from "../types.js";
import { argumentsHash } from "./hash.js";

/** One entry of upstreams.json — the root of trust for origins (§5.1). */
export interface UpstreamConfig {
  canonicalOrigin: string;
  billingOrigin: string;
}

/** Lock an origin from configuration. The only way a `LockedOrigin` should be built. */
export function lockOrigin(
  provider: string,
  config: UpstreamConfig,
  source: LockedOrigin["source"] = "task_configuration",
  now: Date = new Date(),
): LockedOrigin {
  return {
    provider,
    canonicalOrigin: config.canonicalOrigin,
    billingOrigin: config.billingOrigin,
    source,
    lockedAt: now.toISOString(),
  };
}

export interface FreezeInput {
  taskId: string;
  toolCallId: string;
  tool: string;
  arguments: unknown;
  origin: LockedOrigin;
  blocker: Blocker;
  agentId?: string | null;
  surface?: TaskCheckpoint["surface"];
  /** Leave null on CLI paths. Do not fabricate it. */
  originalGoal?: string | null;
  now?: Date;
}

export function freezeCheckpoint(input: FreezeInput): TaskCheckpoint {
  return {
    taskId: input.taskId,
    agentId: input.agentId ?? null,
    toolCallId: input.toolCallId,
    surface: input.surface ?? "cli",
    originalGoal: input.originalGoal ?? null,
    tool: input.tool,
    arguments: input.arguments,
    argumentsHash: argumentsHash(input.arguments),
    origin: input.origin,
    blocker: input.blocker,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

/** The requirement a checkpoint implies, falling back to the quoted package size. */
export function requirementFor(checkpoint: TaskCheckpoint, fallbackAmount: number): Requirement {
  return {
    resource: checkpoint.blocker.resource,
    amount: checkpoint.blocker.required ?? fallbackAmount,
  };
}
