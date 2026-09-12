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
import { executePurchase, readBalance } from "./purchase.js";
import { verifyEntitlement } from "./verify.js";
import { buildResumeToken } from "../resume/resume-token.js";
import {
  InMemoryIdempotencyStore,
  purchaseKey,
  type IdempotencyStore,
} from "./idempotency.js";
import { NoFastLaneError } from "../errors.js";

export interface FastLaneDeps {
  /** Live WebMCP connection to the vendor, supplied by the host agent. */
  session: WebMcpSession;
  /** Idempotency persistence. Defaults to in-memory (demo only). */
  store?: IdempotencyStore;
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
  assertPurchaseAllowed({ mandate: request.mandate, quote: request.quote, session, now: now() });
  emit({ type: "PURCHASE_GUARDED" });

  // 3. Idempotency: claim the purchase before calling the tool -----------------
  const key = purchaseKey(request.mandate, request.quote);
  const purchaseId = `pur_${request.mandate.mandateId}`;
  const claim = await store.putIfAbsent({
    idempotencyKey: key,
    mandateId: request.mandate.mandateId,
    purchaseId,
    status: "PENDING",
  });

  if (claim.status === "COMPLETED") {
    // Already bought in a prior attempt — re-read current state and re-issue the
    // resume token. We do NOT apply the delta check here: the balance already
    // reflects the completed purchase, so there is no "before" to compare.
    emit({ type: "PURCHASE_SKIPPED_DUPLICATE", purchaseId: claim.purchaseId });
    const current = await readBalance(session, capability);
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

  let outcome;
  try {
    outcome = await executePurchase(session, capability, request.quote, request.mandate);
  } catch (err) {
    await store.update(key, { status: "FAILED" });
    throw err;
  }
  await store.update(key, { status: "COMPLETED", transactionId: outcome.transactionId });
  emit({ type: "PURCHASE_COMPLETED", transactionId: outcome.transactionId });

  // 5. Verify entitlement ------------------------------------------------------
  const entitlement = await verifyEntitlement(session, capability, before, request.quote);
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
