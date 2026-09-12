/**
 * Fast-lane orchestrator.
 *
 * The whole of this module's responsibility, in order:
 *
 *   detect WebMCP  →  guard  →  (idempotency)  →  purchase  →  verify  →  resume token
 *
 * If WebMCP isn't available it throws `NoFastLaneError` so the host can fall
 * back to the slow lane (Steel + Playwright), which lives elsewhere.
 */

import type { FastLaneRequest, FastLaneResult } from "../types.js";
import type { WebMcpSession } from "../webmcp/session.js";
import { detectWebMcp } from "../webmcp/detector.js";
import { assertPurchaseAllowed } from "./guards.js";
import { executePurchase, readBalance, type PurchaseOutcome } from "./purchase.js";
import { verifyEntitlement, DEFAULT_VERIFY_RETRY, type VerifyRetryOptions } from "./verify.js";
import { buildResumeToken } from "../resume/resume-token.js";
import {
  InMemoryIdempotencyStore,
  purchaseKey,
  type IdempotencyStore,
} from "./idempotency.js";
import { NoFastLaneError, PurchaseFailedError, PurchaseInFlightError, PurchaseVerificationError } from "../errors.js";

export interface FastLaneDeps {
  /** Live WebMCP connection to the vendor, supplied by the host agent. */
  session: WebMcpSession;
  /**
   * Shared secret the approval/policy layer used to sign the mandate
   * (`signMandate` in `./guards.js`). Required — there is no default,
   * because a default would mean every mandate verifies.
   */
  mandateSecret: string;
  /** Idempotency persistence. Defaults to in-memory (demo only). */
  store?: IdempotencyStore;
  /** Balance-read retry policy for entitlement verification. Defaults to 3 attempts, 200ms apart. */
  verifyRetry?: VerifyRetryOptions;
  /** Optional event sink for the shared timeline / UI. */
  emit?: (event: FastLaneEvent) => void;
  now?: () => Date;
}

export type FastLaneEvent =
  | { type: "WEBMCP_DETECTED"; tools: string[]; viable: boolean; reason: string }
  | { type: "PURCHASE_GUARDED" }
  | { type: "PURCHASE_SKIPPED_DUPLICATE"; purchaseId: string }
  | { type: "PURCHASE_STARTED"; lane: "fast"; tool: string }
  | { type: "PURCHASE_COMPLETED"; transactionId: string }
  | { type: "PURCHASE_RECOVERED_AFTER_AMBIGUOUS_FAILURE"; observedBalance: number }
  | { type: "ENTITLEMENT_VERIFIED"; balance: number }
  | { type: "RESUME_TOKEN_CREATED"; resumeTokenId: string };

export async function runFastLane(
  request: FastLaneRequest,
  deps: FastLaneDeps,
): Promise<FastLaneResult> {
  const { session } = deps;
  const store = deps.store ?? new InMemoryIdempotencyStore();
  const now = deps.now ?? (() => new Date());
  const emit = deps.emit ?? (() => {});

  // 1. Detect WebMCP -----------------------------------------------------------
  const detection = await detectWebMcp(session);
  emit({
    type: "WEBMCP_DETECTED",
    tools: detection.discoveredTools,
    viable: detection.viable,
    reason: detection.reason,
  });
  if (!detection.viable || !detection.capability) {
    throw new NoFastLaneError(detection.reason);
  }
  const capability = detection.capability;

  // 2. Guard (origin lock, amount ceiling, signature, single-use) --------------
  assertPurchaseAllowed({
    mandate: request.mandate,
    quote: request.quote,
    session,
    mandateSecret: deps.mandateSecret,
    now: now(),
  });
  emit({ type: "PURCHASE_GUARDED" });

  // 3. Idempotency: claim the purchase before calling the tool -----------------
  const key = purchaseKey(request.mandate, request.quote);
  const purchaseId = `pur_${request.mandate.mandateId}`;
  const { record: claim, created } = await store.putIfAbsent({
    idempotencyKey: key,
    mandateId: request.mandate.mandateId,
    purchaseId,
    status: "PENDING",
  });

  if (!created && claim.status === "PENDING") {
    // Someone else's attempt for this exact requirement is still running.
    // Proceeding would risk buying twice for one crashed-and-retried call.
    throw new PurchaseInFlightError(
      `Purchase for key ${key} (mandate ${claim.mandateId}) is already in progress.`,
    );
  }

  if (!created && claim.status === "FAILED") {
    // A previous attempt did not complete. Re-claim it so a concurrent retry
    // now sees PENDING rather than a free-to-grab FAILED record.
    await store.update(key, { status: "PENDING" });
  }

  if (claim.status === "COMPLETED") {
    // Already bought in a prior attempt — re-read current state and re-issue
    // the resume token. There is no "before" balance to delta against, but we
    // still refuse to call this verified if the account no longer holds at
    // least what the purchase was supposed to add (e.g. it was spent by
    // something else since) — resuming on a stale record would just send the
    // host straight back into the same paywall.
    emit({ type: "PURCHASE_SKIPPED_DUPLICATE", purchaseId: claim.purchaseId });
    const current = await readBalance(session, capability);
    if (current.balance < request.quote.purchase.credits) {
      throw new PurchaseVerificationError(
        `Purchase ${claim.purchaseId} was already recorded as completed, but current balance ` +
          `${current.balance} is below the ${request.quote.purchase.credits} credits it was supposed to add. ` +
          `Refusing to resume on a stale completion record.`,
      );
    }
    const entitlementDup = {
      provider: capability.provider,
      accountId: current.accountId,
      resource: current.resource,
      balance: current.balance,
      status: "active" as const,
      lastVerifiedAt: now().toISOString(),
    };
    emit({ type: "ENTITLEMENT_VERIFIED", balance: entitlementDup.balance });
    const resumeToken = buildResumeToken(
      request.checkpoint,
      entitlementDup,
      request.quote.purchase.credits,
      now(),
    );
    emit({ type: "RESUME_TOKEN_CREATED", resumeTokenId: resumeToken.id });
    return { purchaseId: claim.purchaseId, verifiedEntitlement: entitlementDup, resumeToken };
  }

  // 4. Purchase ----------------------------------------------------------------
  const before = await readBalance(session, capability);
  emit({ type: "PURCHASE_STARTED", lane: "fast", tool: capability.purchaseTool.name });

  let outcome: PurchaseOutcome;
  try {
    outcome = await executePurchase(session, capability, request.quote, request.mandate);
    await store.update(key, { status: "COMPLETED", transactionId: outcome.transactionId });
    emit({ type: "PURCHASE_COMPLETED", transactionId: outcome.transactionId });
  } catch (err) {
    if (err instanceof PurchaseFailedError) {
      // The vendor explicitly reported failure — unambiguous, nothing to
      // recover. Free the slot for a genuine retry.
      await store.update(key, { status: "FAILED" });
      throw err;
    }
    // Ambiguous failure: a network error, timeout, or dropped connection
    // means we don't know whether the vendor processed the purchase before
    // the response was lost. Check balance BEFORE ever concluding "it
    // failed" — assuming failure here is exactly what leads to double-buying
    // on the next retry.
    const observed = await readBalance(session, capability).catch(() => undefined);
    if (observed && observed.balance >= before.balance + request.quote.purchase.credits) {
      outcome = { transactionId: `recovered_${request.mandate.nonce}`, raw: undefined };
      await store.update(key, { status: "COMPLETED", transactionId: outcome.transactionId });
      emit({ type: "PURCHASE_RECOVERED_AFTER_AMBIGUOUS_FAILURE", observedBalance: observed.balance });
    } else {
      await store.update(key, { status: "FAILED" });
      throw err;
    }
  }

  // 5. Verify entitlement ------------------------------------------------------
  const entitlement = await verifyEntitlement(session, capability, before, request.quote, deps.verifyRetry ?? DEFAULT_VERIFY_RETRY);
  emit({ type: "ENTITLEMENT_VERIFIED", balance: entitlement.balance });

  // 6. Resume token ------------------------------------------------------------
  const resumeToken = buildResumeToken(
    request.checkpoint,
    entitlement,
    request.quote.purchase.credits,
    now(),
  );
  emit({ type: "RESUME_TOKEN_CREATED", resumeTokenId: resumeToken.id });

  return { purchaseId, verifiedEntitlement: entitlement, resumeToken };
}
