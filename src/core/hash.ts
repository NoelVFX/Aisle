/**
 * Stable hashing + the four idempotency keys (aisle-pipeline.md §7, §20).
 *
 *   purchase:  purchase:{taskId}:{requirementHash}
 *   resume:    resume:{taskId}:{failedToolCallId}
 *   approval:  approval:{mandateId}
 *   adapter:   adapter:{billingOrigin}:{version}
 *
 * These must be stable across processes, so everything goes through sha256 of
 * a canonical serialization — never a non-cryptographic or key-order-dependent hash.
 */

import { createHash } from "node:crypto";

/** JSON with recursively sorted object keys and no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** sha256 of the canonical JSON of the blocked call's arguments. */
export function argumentsHash(args: unknown): string {
  return sha256(canonicalJson(args ?? null));
}

/** requirementHash = sha256(provider + resource + amount). Same shortfall → same purchase. */
export function requirementHash(provider: string, resource: string, amount: number): string {
  return sha256(`${provider}|${resource}|${amount}`);
}

export const purchaseKey = (taskId: string, reqHash: string): string => `purchase:${taskId}:${reqHash}`;
export const resumeKey = (taskId: string, failedToolCallId: string): string =>
  `resume:${taskId}:${failedToolCallId}`;
export const approvalKey = (mandateId: string): string => `approval:${mandateId}`;
export const adapterKey = (billingOrigin: string, version: number): string =>
  `adapter:${billingOrigin}:${version}`;
