/**
 * Fast lane (aisle-pipeline.md §13, §14).
 *
 *   detect purchase tools → guard → entitlement check (§8) → claim + consume
 *   mandate → purchase → verify by balance delta (§18) → resume record
 *
 * Seconds, not minutes — but the fast lane does not get to skip verification.
 * If no purchase tool exists it throws `NoFastLaneError` so the router falls
 * back to the slow lane.
 */

import type { RecoveryRequest, RecoveryResult } from "../types.js";
import type { WebMcpSession } from "../webmcp/session.js";
import { detectWebMcp, type FastLaneCapability } from "../webmcp/detector.js";
import { assertPurchaseAllowed } from "./guards.js";
import { executePurchase, readBalance, type BalanceReading } from "./purchase.js";
import { verifyBalanceDelta, type VerifyRetryOptions } from "./verify.js";
import {
  InMemoryIdempotencyStore,
  blocksNewPurchase,
  purchaseKeyFor,
  type IdempotencyStore,
  type PurchaseRecord,
} from "./idempotency.js";
import { MandateRejectedError, NoFastLaneError, PurchaseFailedError, PurchaseInFlightError, PurchaseVerificationError } from "../errors.js";
import { makeEntitlement, makeResult, resolveRequirement } from "../core/outcome.js";

export interface FastLaneDeps {
  /** Live connection to the vendor's purchase tools, supplied by the gateway/host. */
  session: WebMcpSession;
  /** Idempotency + mandate consumption. Defaults to in-memory (demo only). */
  store?: IdempotencyStore;
  /** Event sink for the shared timeline. */
  emit?: (event: FastLaneEvent) => void;
  now?: () => Date;
  /** HMAC secret for mandate verification; defaults to process.env.MANDATE_SECRET. */
  mandateSecret?: string;
  /** Balance verification reads; defaults to 3 attempts, 200ms apart. */
  verifyRetry?: VerifyRetryOptions;
}

export type FastLaneEvent =
  | { type: "WEBMCP_DETECTED"; tools: string[]; viable: boolean; reason: string }
  | { type: "PURCHASE_GUARDED" }
  | { type: "ENTITLEMENT_CHECKED"; balance: number; required: number }
  | { type: "ALREADY_COVERED"; balance: number; required: number }
  | { type: "PURCHASE_SKIPPED_DUPLICATE"; purchaseId: string; status: PurchaseRecord["status"] }
  | { type: "PURCHASE_STARTED"; lane: "fast"; tool: string }
  | { type: "PURCHASE_SUBMITTED" }
  | { type: "PURCHASE_COMPLETED"; transactionId: string | undefined }
  | { type: "PURCHASE_RESULT_UNKNOWN"; error: string }
  | { type: "ENTITLEMENT_VERIFIED"; before: number; after: number }
  | { type: "RESUME_TOKEN_CREATED"; resumeTokenId: string };

export async function runFastLane(request: RecoveryRequest, deps: FastLaneDeps): Promise<RecoveryResult> {
  const { session } = deps;
  const { mandate, quote, checkpoint } = request;
  const store = deps.store ?? new InMemoryIdempotencyStore();
  const now = deps.now ?? (() => new Date());
  const emit = deps.emit ?? (() => {});
  const requirement = resolveRequirement(request);

  // 1. Detect ------------------------------------------------------------------
  const detection = await detectWebMcp(session);
  emit({ type: "WEBMCP_DETECTED", tools: detection.discoveredTools, viable: detection.viable, reason: detection.reason });
  if (!detection.viable || !detection.capability) throw new NoFastLaneError(detection.reason);
  const capability = detection.capability;

  // 2. Guard (signature, expiry, origin lock, provider, cap) -------------------
  assertPurchaseAllowed({
    checkpoint,
    mandate,
    quote,
    actualOrigin: session.origin,
    actualProvider: session.provider,
    lane: "fast",
    now: now(),
    ...(deps.mandateSecret === undefined ? {} : { mandateSecret: deps.mandateSecret }),
  });
  emit({ type: "PURCHASE_GUARDED" });

  const key = purchaseKeyFor(mandate, requirement);
  const purchaseId = `pur_${mandate.mandateId}`;
  // Vendor-side dedupe key: stable across retries of THIS approved purchase, new
  // for the next approved mandate. Reusing `key` alone would make a vendor that
  // dedupes on it silently skip a later, legitimate purchase in the same task.
  const vendorIdempotencyKey = `${key}:${mandate.mandateId}`;

  /** A balance reported for a different resource must never count toward this task. */
  const assertResource = (reading: BalanceReading): void => {
    if (reading.resource !== undefined && reading.resource !== requirement.resource) {
      throw new PurchaseVerificationError(
        `Balance tool reports '${reading.resource}', but the task needs '${requirement.resource}'. Refusing to use it.`,
      );
    }
  };

  const finish = (reading: BalanceReading, pid: string | null, alreadyCovered: boolean) => {
    const balance = { balance: reading.balance, accountId: reading.accountId, resource: reading.resource ?? requirement.resource };
    const entitlement = makeEntitlement(mandate, balance, now());
    const result = makeResult({ lane: "fast", purchaseId: pid, entitlement, request, requirement, alreadyCovered, now: now() });
    emit({ type: "RESUME_TOKEN_CREATED", resumeTokenId: result.resumeToken.id });
    return result;
  };

  // A prior attempt that may have moved money: decide from observed state, never re-buy.
  const resolveExisting = async (existing: PurchaseRecord): Promise<RecoveryResult> => {
    emit({ type: "PURCHASE_SKIPPED_DUPLICATE", purchaseId: existing.purchaseId, status: existing.status });
    if (existing.status === "PENDING") {
      throw new PurchaseInFlightError(`Purchase for key ${key} is already in progress.`);
    }
    const current = await readBalance(session, capability);
    assertResource(current);
    if (current.balance < requirement.amount) {
      throw new PurchaseVerificationError(
        `A previous purchase attempt (${existing.status}) exists for this requirement but the balance ` +
          `${current.balance} does not cover ${requirement.amount}. Not buying again; needs human review.`,
      );
    }
    if (existing.status !== "VERIFIED") await store.update(key, { status: "VERIFIED" });
    return finish(current, existing.purchaseId, false);
  };

  const existing = await store.get(key);
  if (blocksNewPurchase(existing)) return resolveExisting(existing);

  // 3. Entitlement check — the moment Aisle sometimes DOESN'T buy (§8) ----------
  const before = await readBalance(session, capability);
  assertResource(before);
  emit({ type: "ENTITLEMENT_CHECKED", balance: before.balance, required: requirement.amount });
  if (before.balance >= requirement.amount) {
    emit({ type: "ALREADY_COVERED", balance: before.balance, required: requirement.amount });
    return finish(before, null, true);
  }

  // 4. Claim the requirement, then consume the single-use mandate ---------------
  const claim = await store.claim({ idempotencyKey: key, mandateId: mandate.mandateId, purchaseId, status: "PENDING" });
  if (!claim.claimed) return resolveExisting(claim.record);
  if (!(await store.consumeMandate(mandate.mandateId))) {
    await store.update(key, { status: "FAILED" });
    throw new MandateRejectedError(`Mandate ${mandate.mandateId} was already used.`, "MANDATE_ALREADY_USED");
  }

  // 5. Purchase ----------------------------------------------------------------
  emit({ type: "PURCHASE_STARTED", lane: "fast", tool: capability.purchaseTool.name });
  emit({ type: "PURCHASE_SUBMITTED" });
  try {
    const outcome = await executePurchase(session, capability, mandate, vendorIdempotencyKey);
    await store.update(key, {
      status: "SUBMITTED",
      ...(outcome.transactionId === undefined ? {} : { transactionId: outcome.transactionId }),
    });
    emit({ type: "PURCHASE_COMPLETED", transactionId: outcome.transactionId });
  } catch (err) {
    if (err instanceof PurchaseFailedError) {
      await store.update(key, { status: "FAILED" });
      throw err;
    }
    // Response lost: we genuinely don't know if we were charged. NEVER retry.
    await store.update(key, { status: "UNKNOWN" });
    emit({ type: "PURCHASE_RESULT_UNKNOWN", error: String(err) });
  }

  // 6. Verify by reading the balance, not the receipt ---------------------------
  // An unconfirmed balance must keep SUBMITTED/UNKNOWN blocking new purchases.
  // Only an explicit vendor refusal above can mark this attempt FAILED.
  const after = await verifyBalanceDelta(session, capability, before, mandate.unitsGranted, deps.verifyRetry);
  await store.update(key, { status: "VERIFIED" });
  emit({ type: "ENTITLEMENT_VERIFIED", before: before.balance, after: after.balance });

  return finish(after, purchaseId, false);
}

export type { FastLaneCapability };
