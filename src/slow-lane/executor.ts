/**
 * Slow-lane orchestrator (the BrowserPurchaseWorker).
 *
 * Runs when the fast lane isn't viable (no WebMCP purchase tool). It drives a
 * real browser (Steel Cloud + Playwright over CDP) through the vendor's
 * checkout, then converges on the SAME outcome as the fast lane: a verified
 * entitlement + a resume token.
 *
 *   open session (resume profile) → origin lock → discover offers →
 *   stage purchase → confirm (transactional) → verify entitlement →
 *   save profile → resume token
 *
 * Every deterministic step can fall back to the host-injected computer-use
 * agent when the page shape defeats the scripted selectors.
 */

import type {
  Entitlement,
  FastLaneRequest,
  PurchaseVerification,
  RecoveryResult,
  Requirement,
} from "../types.js";
import { assertPurchaseAllowed } from "../fast-lane/guards.js";
import {
  InMemoryIdempotencyStore,
  purchaseKey,
  type IdempotencyStore,
} from "../fast-lane/idempotency.js";
import { buildResumeToken } from "../resume/resume-token.js";
import {
  MandateRejectedError,
  PurchaseFailedError,
  PurchaseVerificationError,
} from "../errors.js";
import { originOf, type BrowserProvider, type BrowserSession } from "./browser.js";
import {
  DeterministicStepError,
  type VendorPurchaseAdapter,
} from "./vendor-adapter.js";
import type { ComputerUseAgent } from "./computer-use.js";
import type { ProfileStore } from "./profiles.js";

export interface SlowLaneDeps {
  provider: BrowserProvider;
  adapter: VendorPurchaseAdapter;
  /** Persisted auth profiles (Steel session context). Optional. */
  profiles?: ProfileStore;
  /** Host-injected computer-use fallback. Optional. */
  agent?: ComputerUseAgent;
  store?: IdempotencyStore;
  emit?: (event: SlowLaneEvent) => void;
  now?: () => Date;
}

export type SlowLaneEvent =
  | { type: "STEEL_SESSION_CREATED"; sessionId: string; sessionViewerUrl?: string }
  | { type: "PROFILE_LOADED"; provider: string }
  | { type: "PAGE_OPENED"; url: string }
  | { type: "PURCHASE_GUARDED" }
  | { type: "OFFERS_DISCOVERED"; count: number }
  | { type: "OFFER_SELECTED"; productId: string; price: number }
  | { type: "PURCHASE_STAGED"; observedTotal: number }
  | { type: "COMPUTER_USE_INVOKED"; instruction: string }
  | { type: "PURCHASE_SUBMITTED" }
  | { type: "PURCHASE_SKIPPED_DUPLICATE"; purchaseId: string }
  | { type: "PURCHASE_RESULT_UNKNOWN" }
  | { type: "PURCHASE_COMPLETED"; transactionId?: string }
  | { type: "ENTITLEMENT_VERIFIED"; balance?: number }
  | { type: "PROFILE_SAVED"; provider: string }
  | { type: "RESUME_TOKEN_CREATED"; resumeTokenId: string }
  | { type: "SESSION_CLOSED" };

export async function runSlowLane(
  request: FastLaneRequest,
  deps: SlowLaneDeps,
): Promise<RecoveryResult> {
  const { mandate, quote, checkpoint } = request;
  const store = deps.store ?? new InMemoryIdempotencyStore();
  const now = deps.now ?? (() => new Date());
  const emit = deps.emit ?? (() => {});
  const requirement: Requirement =
    request.requirement ?? { resource: "credits", amount: quote.purchase.credits };

  // Resume a saved profile so the vendor stays authenticated.
  const profile = deps.profiles ? await deps.profiles.load(mandate.provider) : undefined;
  if (profile) emit({ type: "PROFILE_LOADED", provider: mandate.provider });

  const session: BrowserSession = await deps.provider.createSession(
    profile ? { provider: mandate.provider, profile } : { provider: mandate.provider },
  );
  emit(
    session.sessionViewerUrl === undefined
      ? { type: "STEEL_SESSION_CREATED", sessionId: session.sessionId }
      : {
          type: "STEEL_SESSION_CREATED",
          sessionId: session.sessionId,
          sessionViewerUrl: session.sessionViewerUrl,
        },
  );

  // Run a deterministic step; on a DeterministicStepError, delegate the stuck
  // sub-goal to the computer-use agent (if present) and retry the read once.
  const runStep = async <T>(fn: () => Promise<T>, fallbackInstruction: string): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DeterministicStepError && deps.agent) {
        const instruction = err.recoveryInstruction || fallbackInstruction;
        emit({ type: "COMPUTER_USE_INVOKED", instruction });
        const outcome = await deps.agent.run(session.control, instruction);
        if (!outcome.success) throw err;
        return await fn();
      }
      throw err;
    }
  };

  try {
    // 1. Open the task-authorized origin. The origin comes from the mandate,
    //    never from tool output or page content.
    await session.page.goto(mandate.origin);
    emit({ type: "PAGE_OPENED", url: session.page.currentUrl() });

    // 2. Origin lock + provider + ceiling guards (shared with the fast lane).
    assertPurchaseAllowed({
      mandate,
      quote,
      actualOrigin: originOf(session.page.currentUrl()),
      actualProvider: session.provider,
      now: now(),
    });
    if (!deps.adapter.canHandle(session.page.currentUrl())) {
      throw new PurchaseFailedError(
        `Adapter '${deps.adapter.provider}' cannot handle ${session.page.currentUrl()}.`,
      );
    }
    emit({ type: "PURCHASE_GUARDED" });

    // 3. Discover offers and bind execution to the approved product.
    const offers = await runStep(
      () => deps.adapter.discoverOffers(session.page, requirement),
      "Open the pricing page and list the available credit packages.",
    );
    emit({ type: "OFFERS_DISCOVERED", count: offers.length });

    const offer = offers.find((o) => o.productId === quote.purchase.productId);
    if (!offer) {
      throw new PurchaseFailedError(
        `Quoted product '${quote.purchase.productId}' not found on the vendor pricing page.`,
      );
    }
    if (offer.price > mandate.maximumAmount) {
      throw new MandateRejectedError(
        `Discovered price ${offer.price} exceeds mandate maximum ${mandate.maximumAmount}.`,
      );
    }
    emit({ type: "OFFER_SELECTED", productId: offer.productId, price: offer.price });

    // 4. Stage the checkout (do not confirm). Re-check the observed total in case
    //    the checkout page inflates the price.
    const staged = await runStep(
      () => deps.adapter.stagePurchase(session.page, offer),
      `Select the '${offer.label}' package and proceed to checkout.`,
    );
    emit({ type: "PURCHASE_STAGED", observedTotal: staged.observedTotal });
    if (staged.observedTotal > mandate.maximumAmount) {
      throw new MandateRejectedError(
        `Checkout total ${staged.observedTotal} exceeds mandate maximum ${mandate.maximumAmount}.`,
      );
    }

    // 5. Idempotency: claim the purchase before confirming.
    const key = purchaseKey(mandate, quote);
    const purchaseId = `pur_${mandate.mandateId}`;
    const claim = await store.putIfAbsent({
      idempotencyKey: key,
      mandateId: mandate.mandateId,
      purchaseId,
      status: "PENDING",
    });
    if (claim.status === "COMPLETED") {
      emit({ type: "PURCHASE_SKIPPED_DUPLICATE", purchaseId: claim.purchaseId });
      const current = await deps.adapter.verifyEntitlement(session.page, requirement);
      const result = await finish(claim.purchaseId, current);
      return result;
    }

    // 6. Confirm — transactional. If the click result is lost, we do NOT retry
    //    the click; we resolve the outcome by re-reading authoritative state.
    emit({ type: "PURCHASE_SUBMITTED" });
    try {
      await runStep(
        () => deps.adapter.confirmPurchase(session.page, staged),
        "Click the final confirm/pay button to complete the purchase.",
      );
    } catch {
      emit({ type: "PURCHASE_RESULT_UNKNOWN" });
      // fall through to authoritative verification
    }

    // 7. Verify authoritative entitlement.
    const verification = await deps.adapter.verifyEntitlement(session.page, requirement);
    const result = await finish(purchaseId, verification, key);
    return result;

    // ---- local helpers ----
    async function finish(
      pid: string,
      verification: PurchaseVerification,
      idemKey?: string,
    ): Promise<RecoveryResult> {
      const sufficient =
        verification.confirmed || (verification.balanceAfter ?? -1) >= requirement.amount;
      if (!sufficient) {
        if (idemKey) await store.update(idemKey, { status: "FAILED" });
        throw new PurchaseVerificationError(
          `Entitlement not confirmed after purchase (balance ${verification.balanceAfter ?? "unknown"}, ` +
            `need ${requirement.amount}).`,
        );
      }
      if (idemKey) {
        await store.update(
          idemKey,
          verification.transactionId === undefined
            ? { status: "COMPLETED" }
            : { status: "COMPLETED", transactionId: verification.transactionId },
        );
      }
      emit({ type: "PURCHASE_COMPLETED", transactionId: verification.transactionId });

      const entitlement: Entitlement = {
        provider: mandate.provider,
        accountId: verification.accountId ?? "unknown",
        resource: verification.resource ?? requirement.resource,
        balance: verification.balanceAfter ?? requirement.amount,
        status: "active",
        lastVerifiedAt: now().toISOString(),
      };
      emit({ type: "ENTITLEMENT_VERIFIED", balance: entitlement.balance });

      // Persist the (now-authenticated) profile for next time.
      if (deps.profiles) {
        const saved = await session.saveProfile();
        await deps.profiles.save(saved);
        emit({ type: "PROFILE_SAVED", provider: mandate.provider });
      }

      const resumeToken = buildResumeToken(checkpoint, entitlement, requirement.amount, now());
      emit({ type: "RESUME_TOKEN_CREATED", resumeTokenId: resumeToken.id });

      return { lane: "slow", purchaseId: pid, verifiedEntitlement: entitlement, resumeToken };
    }
  } finally {
    await session.close();
    emit({ type: "SESSION_CLOSED" });
  }
}
