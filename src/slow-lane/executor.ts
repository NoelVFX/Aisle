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
  TakeoverRequiredError,
} from "../errors.js";
import { originOf, type BrowserProvider, type BrowserSession } from "./browser.js";
import {
  DeterministicStepError,
  selectOffer,
  type VendorPurchaseAdapter,
} from "./vendor-adapter.js";
import type { ComputerUseAgent } from "./computer-use.js";
import type { ProfileStore } from "./profiles.js";

export interface SlowLaneDeps {
  provider: BrowserProvider;
  adapter: VendorPurchaseAdapter;
  /** Persisted auth profiles (Steel session context). Optional. */
  profiles?: ProfileStore;
  /** Host-injected computer-use fallback (e.g. the OpenRouter agent). Optional. */
  agent?: ComputerUseAgent;
  /**
   * Allow the computer-use agent to recover the FINAL confirm/pay step on a
   * DeterministicStepError. Defaults to true (the tier-2 fallback covers every
   * step). Set false for strict compliance where only deterministic code may
   * submit. Either way, Gate 1 (staged-vs-mandate) and Gate 2 (balance delta)
   * still run, so a wrong click can't become a wrong purchase.
   */
  allowComputerUseOnConfirm?: boolean;
  /**
   * Human-in-the-loop takeover for challenges the automation must not clear
   * (3-DS, OTP, bank verification). Called with the live session; resolve once
   * the human has cleared it, then verification decides the outcome.
   */
  onTakeover?: (ctx: TakeoverContext) => Promise<void>;
  store?: IdempotencyStore;
  emit?: (event: SlowLaneEvent) => void;
  now?: () => Date;
}

export interface TakeoverContext {
  session: BrowserSession;
  taskId: string;
  reason: string;
  sessionViewerUrl?: string;
}

export type SlowLaneEvent =
  | { type: "STEEL_SESSION_CREATED"; sessionId: string; sessionViewerUrl?: string }
  | { type: "PROFILE_LOADED"; provider: string }
  | { type: "PAGE_OPENED"; url: string }
  | { type: "PURCHASE_GUARDED" }
  | { type: "ALREADY_COVERED"; balance: number }
  | { type: "TAKEOVER_REQUESTED"; reason: string; sessionViewerUrl?: string }
  | { type: "RECEIPT_CAPTURED"; count: number }
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

    // 3. Read the current balance first. Enables the §8 ALREADY_COVERED
    //    short-circuit AND anchors the §17 Gate-2 delta check below.
    const beforeCheck = await deps.adapter.verifyEntitlement(session.page, requirement);
    const balanceBefore = beforeCheck.balanceAfter;
    if (balanceBefore !== undefined && balanceBefore >= requirement.amount) {
      emit({ type: "ALREADY_COVERED", balance: balanceBefore });
      return await finish({ pid: `pur_${mandate.mandateId}`, verification: beforeCheck, sufficient: true });
    }

    // 4. Discover offers and bind execution to the approved product.
    const offers = await runStep(
      () => deps.adapter.discoverOffers(session.page, requirement),
      "Open the pricing page and list the available credit packages.",
    );
    emit({ type: "OFFERS_DISCOVERED", count: offers.length });

    const offer = selectOffer(offers, quote, requirement);
    if (!offer) {
      throw new PurchaseFailedError(
        `No offer grants the required ${requirement.amount} ${requirement.resource}.`,
      );
    }
    // Never spend above the mandate ceiling, and never above what was approved.
    if (offer.price > mandate.maximumAmount) {
      throw new MandateRejectedError(
        `Selected price ${offer.price} exceeds mandate maximum ${mandate.maximumAmount}.`,
      );
    }
    if (offer.price > quote.purchase.price) {
      throw new MandateRejectedError(
        `Selected price ${offer.price} exceeds the approved quote ${quote.purchase.price}.`,
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
      const sufficient = current.confirmed || (current.balanceAfter ?? -1) >= requirement.amount;
      return await finish({ pid: claim.purchaseId, verification: current, sufficient });
    }

    // 7. Confirm — transactional. Tier-2 fallback: on a DeterministicStepError
    //    the (OpenRouter) computer-use agent recovers the step, unless disabled.
    //    A challenge (3-DS/OTP) raises TakeoverRequiredError → human takeover.
    emit({ type: "PURCHASE_SUBMITTED" });
    const confirmInstruction =
      "Click the final confirm/pay button to complete the already-authorized purchase. " +
      "Do not change any amount or product.";
    const allowConfirmFallback = deps.allowComputerUseOnConfirm ?? true;
    try {
      if (allowConfirmFallback) {
        await runStep(() => deps.adapter.confirmPurchase(session.page, staged), confirmInstruction);
      } else {
        await deps.adapter.confirmPurchase(session.page, staged);
      }
    } catch (err) {
      if (err instanceof TakeoverRequiredError) {
        emit(
          session.sessionViewerUrl === undefined
            ? { type: "TAKEOVER_REQUESTED", reason: err.message }
            : { type: "TAKEOVER_REQUESTED", reason: err.message, sessionViewerUrl: session.sessionViewerUrl },
        );
        if (!deps.onTakeover) throw err;
        await deps.onTakeover({
          session,
          taskId: checkpoint.taskId,
          reason: err.message,
          sessionViewerUrl: session.sessionViewerUrl,
        });
        // Human cleared the challenge; verification below decides the outcome.
      } else {
        emit({ type: "PURCHASE_RESULT_UNKNOWN" });
        // fall through to authoritative verification
      }
    }

    // 8. Verify — §17 Gate 2: prove the balance rose by (at least) what the
    //    selected offer grants, not merely that it now clears the requirement.
    const after = await deps.adapter.verifyEntitlement(session.page, requirement);
    const balanceAfter = after.balanceAfter;
    const granted = offer.units;
    const sufficient =
      balanceBefore !== undefined && balanceAfter !== undefined
        ? balanceAfter >= balanceBefore + granted // delta (preferred)
        : balanceAfter !== undefined
          ? balanceAfter >= requirement.amount // fallback: absolute
          : after.confirmed; // last resort: adapter's own flag
    return await finish({ pid: purchaseId, verification: after, sufficient, idemKey: key });

    // ---- local helper ----
    async function finish(args: {
      pid: string;
      verification: PurchaseVerification;
      sufficient: boolean;
      idemKey?: string;
    }): Promise<RecoveryResult> {
      const { pid, verification, sufficient, idemKey } = args;
      if (!sufficient) {
        if (idemKey) await store.update(idemKey, { status: "FAILED" });
        throw new PurchaseVerificationError(
          `Entitlement not confirmed after purchase (balance ${verification.balanceAfter ?? "unknown"}, ` +
            `before ${balanceBefore ?? "unknown"}, need ${requirement.amount}).`,
        );
      }
      if (idemKey) {
        await store.update(
          idemKey,
          verification.transactionId === undefined
            ? { status: "COMPLETED" }
            : { status: "COMPLETED", transactionId: verification.transactionId },
        );
        emit({ type: "PURCHASE_COMPLETED", transactionId: verification.transactionId });
      }

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

      // Capture receipt/invoice/license files from the Steel session.
      let receiptFileIds: string[] = [];
      if (session.listReceiptFiles) {
        try {
          receiptFileIds = await session.listReceiptFiles();
        } catch {
          receiptFileIds = [];
        }
        if (receiptFileIds.length > 0) {
          emit({ type: "RECEIPT_CAPTURED", count: receiptFileIds.length });
        }
      }

      const resumeToken = buildResumeToken(checkpoint, entitlement, requirement.amount, now());
      emit({ type: "RESUME_TOKEN_CREATED", resumeTokenId: resumeToken.id });

      const result: RecoveryResult = {
        lane: "slow",
        purchaseId: pid,
        verifiedEntitlement: entitlement,
        resumeToken,
      };
      if (session.sessionViewerUrl) result.sessionViewerUrl = session.sessionViewerUrl;
      if (receiptFileIds.length > 0) result.receiptFileIds = receiptFileIds;
      return result;
    }
  } finally {
    await session.close();
    emit({ type: "SESSION_CLOSED" });
  }
}
