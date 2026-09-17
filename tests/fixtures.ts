/** Builds spec-shaped requests the way the pipeline does: lock → freeze → quote → sign. */

import { freezeCheckpoint, lockOrigin } from "../src/core/checkpoint.js";
import { signMandate } from "../src/mandate/mandate.js";
import type { Blocker, Quote, RecoveryRequest } from "../src/types.js";

export const SECRET = "test-secret";

export interface RequestOptions {
  provider: string;
  origin: string;
  /** Defaults to `origin`. */
  billingOrigin?: string;
  taskId?: string;
  productId?: string;
  units?: number;
  price?: number;
  /** blocker.required — the minimum the task needs. */
  required?: number;
  /** Sign the mandate as if at this time (for expiry tests). */
  signedAt?: Date;
  quote?: Partial<Quote>;
}

export function makeRequest(opts: RequestOptions): RecoveryRequest {
  const taskId = opts.taskId ?? "task_1";
  const billingOrigin = opts.billingOrigin ?? opts.origin;
  const blocker: Blocker = {
    type: "INSUFFICIENT_CREDITS",
    resource: "credits",
    required: opts.required ?? 3200,
    confidence: "high",
    raw: { status: 402, code: "insufficient_credits" },
  };
  const checkpoint = freezeCheckpoint({
    taskId,
    toolCallId: "call_2",
    tool: "generate_image",
    arguments: { prompt: "hero #2" },
    origin: lockOrigin(opts.provider, { canonicalOrigin: opts.origin, billingOrigin }),
    blocker,
    agentId: "hermes",
  });
  const quote: Quote = {
    provider: opts.provider,
    billingOrigin,
    productId: opts.productId ?? "credits_5000",
    quantity: 1,
    unitsGranted: opts.units ?? 5000,
    price: opts.price ?? 20,
    currency: "USD",
    billing: "one_time",
    autoRenew: false,
    reason: "needs credits",
    ...opts.quote,
  };
  const mandate = signMandate(
    quote,
    { taskId, recoveryJobId: "job_1", userId: "demo-user" },
    { secret: SECRET, ...(opts.signedAt ? { now: opts.signedAt } : {}) },
  );
  return { checkpoint, quote, mandate };
}
