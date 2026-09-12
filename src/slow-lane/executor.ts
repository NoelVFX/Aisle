/**
 * Slow lane — the browser purchase worker (steel.md §20, aisle-pipeline.md §15, §18).
 *
 *   open session on the (user, vendor) Steel profile → navigate to the LOCKED
 *   billing origin → guard → liveness probe → entitlement check → discover
 *   offers → stage → Gate 1 (staged vs mandate) → claim + consume mandate →
 *   deterministic submit → verify by balance delta (Gate 2) → mark profile
 *   verified → receipts → release → wait for profile READY → resume record
 *
 * A model is never in the submit, the gate, the origin decision, the mandate
 * comparison, or the verification (§16.1). The computer-use resolver may only
 * recover discovery and staging, within a per-job budget (§16.6).
 */

import type { RecoveryRequest, RecoveryResult, StagedCheckout } from "../types.js";
import { assertPurchaseAllowed } from "../fast-lane/guards.js";
import {
  InMemoryIdempotencyStore,
  blocksNewPurchase,
  purchaseKeyFor,
  type IdempotencyStore,
  type PurchaseRecord,
} from "../fast-lane/idempotency.js";
import { assertBalanceDelta } from "../fast-lane/verify.js";
import { assertMatchesMandate } from "../mandate/mandate.js";
import { loadLimits } from "../policy/policy.js";
import { makeEntitlement, makeResult, resolveRequirement } from "../core/outcome.js";
import {
  MandateRejectedError,
  PurchaseFailedError,
  PurchaseVerificationError,
  PurchaseInFlightError,
  ResolutionExhaustedError,
  SubmitWithheldError,
  TakeoverRequiredError,
} from "../errors.js";
import {
  originOf,
  type BrowserProfile,
  type BrowserProvider,
  type BrowserSession,
  type ProfileReadiness,
} from "./browser.js";
import { DeterministicStepError, selectOffer, type VendorPurchaseAdapter } from "./vendor-adapter.js";
import type { ComputerUseAgent } from "./computer-use.js";
import type { ProfileStore } from "./profiles.js";

export interface SlowLaneDeps {
  provider: BrowserProvider;
  adapter: VendorPurchaseAdapter;
  /** (user, vendor) → Steel profile bindings (steel.md §6). Optional; without it every run starts cold. */
  profiles?: ProfileStore;
  /** Computer-use resolver for discovery/staging only. Never used for submit. */
  agent?: ComputerUseAgent;
  /**
   * Max resolver model calls for this job (§16.6). Defaults to
   * MAX_RESOLVER_CALLS_PER_JOB (5). Exceeded → RESOLUTION_EXHAUSTED.
   */
  resolverBudget?: number;
  /**
   * Human-in-the-loop takeover for challenges the automation must not clear
   * (3-DS, OTP, bank verification). Resolve once the human has cleared it; the
   * balance re-read then decides the outcome.
   */
  onTakeover?: (ctx: TakeoverContext) => Promise<void>;
  store?: IdempotencyStore;
  emit?: (event: SlowLaneEvent) => void;
  now?: () => Date;
  /** HMAC secret for mandate verification; defaults to process.env.MANDATE_SECRET. */
  mandateSecret?: string;
  /**
   * Stage the checkout and run Gate 1, then stop before claiming the mandate or
   * clicking submit (SubmitWithheldError). For real-money vendors that are not
   * explicitly enabled.
   */
  stopBeforeSubmit?: boolean;
  /**
   * Web path (web-path.md §2.2): cookies + localStorage captured live from the
   * user's browsing session. The worker session starts from it instead of a
   * stored profile, stays isolated, and persists nothing.
   */
  sessionContext?: unknown;
}

export interface TakeoverContext {
  session: BrowserSession;
  taskId: string;
  reason: string;
  sessionViewerUrl?: string | undefined;
}

/** Events never carry a profileId: it is credential-tier (steel.md §6). */
export type SlowLaneEvent =
  | { type: "STEEL_SESSION_CREATED"; sessionId: string; sessionViewerUrl?: string | undefined }
  | { type: "PROFILE_CREATED"; provider: string; dedicatedIp: boolean }
  | { type: "PAGE_OPENED"; url: string }
  | { type: "PURCHASE_GUARDED" }
  | { type: "PROFILE_RESTORED"; provider: string; fromSavedProfile: boolean; dedicatedIp: boolean; loggedIn: boolean | undefined }
  | { type: "ENTITLEMENT_CHECKED"; balance: number; required: number }
  | { type: "ALREADY_COVERED"; balance: number; required: number }
  | { type: "PURCHASE_SKIPPED_DUPLICATE"; purchaseId: string; status: PurchaseRecord["status"] }
  | { type: "OFFERS_DISCOVERED"; count: number }
  | { type: "OFFER_SELECTED"; productId: string; price: number }
  | { type: "RESOLVER_CALLED"; profile: "VISION"; instruction: string; callsUsed: number; budget: number }
  | ({ type: "CHECKOUT_STAGED" } & StagedCheckout)
  | { type: "MANDATE_COMPARISON_PASSED"; staged: number; cap: number }
  | { type: "SUBMIT_WITHHELD"; staged: number; cap: number }
  | { type: "PURCHASE_STARTED"; lane: "slow" }
  | { type: "PURCHASE_SUBMITTED" }
  | { type: "TAKEOVER_REQUESTED"; reason: string; sessionViewerUrl?: string | undefined }
  | { type: "TAKEOVER_RESOLVED" }
  | { type: "PURCHASE_RESULT_UNKNOWN"; error: string }
  | { type: "PURCHASE_COMPLETED"; transactionId?: string | undefined }
  | { type: "ENTITLEMENT_VERIFIED"; before: number; after: number }
  | { type: "PROFILE_SAVED"; provider: string }
  | { type: "RECEIPT_CAPTURED"; files: number }
  | { type: "RESUME_TOKEN_CREATED"; resumeTokenId: string }
  | { type: "SESSION_CLOSED" }
  | { type: "PROFILE_READY"; provider: string; status: ProfileReadiness | "ERROR" };

export async function runSlowLane(request: RecoveryRequest, deps: SlowLaneDeps): Promise<RecoveryResult> {
  const { mandate, quote, checkpoint } = request;
  const store = deps.store ?? new InMemoryIdempotencyStore();
  const now = deps.now ?? (() => new Date());
  const emit = deps.emit ?? (() => {});
  const requirement = resolveRequirement(request);
  const budget = deps.resolverBudget ?? loadLimits().maxResolverCallsPerJob;
  let callsUsed = 0;

  const stored =
    deps.sessionContext === undefined && deps.profiles ? await deps.profiles.load(mandate.userId, mandate.provider) : undefined;
  const session: BrowserSession = await deps.provider.createSession(
    deps.sessionContext !== undefined
      ? { provider: mandate.provider, sessionContext: deps.sessionContext, persistProfile: false }
      : stored
        ? { provider: mandate.provider, profile: stored }
        : { provider: mandate.provider },
  );
  emit({ type: "STEEL_SESSION_CREATED", sessionId: session.sessionId, sessionViewerUrl: session.sessionViewerUrl });

  /** Set once the profile is marked verified; the READY wait after release keys off it. */
  let verifiedProfileId: string | undefined;

  /** The (user, vendor) binding for the profile this session runs on. */
  const bindingFor = (lastVerifiedAt: string | undefined): BrowserProfile | undefined => {
    const mount = session.profile;
    if (!mount) return undefined;
    return {
      userId: mandate.userId,
      provider: mandate.provider,
      profileId: mount.profileId,
      ...(mount.dedicatedIpId === undefined ? {} : { dedicatedIpId: mount.dedicatedIpId }),
      ...(lastVerifiedAt === undefined ? {} : { lastVerifiedAt }),
    };
  };

  /** Run a read/staging step; on DeterministicStepError, spend resolver budget and retry once. */
  const runStep = async <T>(fn: () => Promise<T>, fallbackInstruction: string): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof DeterministicStepError) || !deps.agent) throw err;
      const remaining = budget - callsUsed;
      if (remaining <= 0) {
        throw new ResolutionExhaustedError(`Resolver budget of ${budget} calls exhausted: ${err.message}`);
      }
      const instruction = err.recoveryInstruction || fallbackInstruction;
      emit({ type: "RESOLVER_CALLED", profile: "VISION", instruction, callsUsed, budget });
      const outcome = await deps.agent.run(session.control, instruction, { maxSteps: remaining });
      callsUsed += Math.max(1, outcome.steps);
      if (!outcome.success) {
        if (callsUsed >= budget) {
          throw new ResolutionExhaustedError(`Resolver budget of ${budget} calls exhausted: ${err.message}`);
        }
        throw err;
      }
      return await fn();
    }
  };

  const readBalance = async (): Promise<{ balance: number | undefined; accountId: string | undefined; resource: string; transactionId: string | undefined }> => {
    const v = await deps.adapter.verifyEntitlement(session.page, requirement);
    return {
      balance: v.balanceAfter,
      accountId: v.accountId,
      resource: v.resource ?? requirement.resource,
      transactionId: v.transactionId,
    };
  };

  const finish = async (
    reading: { balance: number; accountId: string | undefined; resource: string },
    pid: string | null,
    alreadyCovered: boolean,
  ): Promise<RecoveryResult> => {
    const entitlement = makeEntitlement(mandate, reading, now());
    const result = makeResult({ lane: "slow", purchaseId: pid, entitlement, request, requirement, alreadyCovered, now: now() });

    // Mark the identity good only on a verified outcome. Steel writes the
    // userDataDir itself, on release.
    const verified = deps.profiles ? bindingFor(now().toISOString()) : undefined;
    if (deps.profiles && verified) {
      await deps.profiles.save(verified);
      verifiedProfileId = verified.profileId;
      emit({ type: "PROFILE_SAVED", provider: mandate.provider });
    }
    if (session.listReceiptFiles && !alreadyCovered) {
      const files = await session.listReceiptFiles().catch(() => [] as string[]);
      if (files.length > 0) {
        result.receiptFileIds = files;
        emit({ type: "RECEIPT_CAPTURED", files: files.length });
      }
    }
    if (session.sessionViewerUrl) result.sessionViewerUrl = session.sessionViewerUrl;
    emit({ type: "RESUME_TOKEN_CREATED", resumeTokenId: result.resumeToken.id });
    return result;
  };

  try {
    // 0. Bind a newly created profile at once. Steel persists it on release
    //    whatever the outcome, so an unbound id is an orphaned identity.
    const created = stored === undefined ? bindingFor(undefined) : undefined;
    if (deps.profiles && created) {
      await deps.profiles.save(created);
      emit({ type: "PROFILE_CREATED", provider: mandate.provider, dedicatedIp: created.dedicatedIpId !== undefined });
    }

    // 1. Navigate to the LOCKED billing origin — from the checkpoint's config,
    //    never from a 402 body, a page link, or a model.
    await session.page.goto(checkpoint.origin.billingOrigin);
    emit({ type: "PAGE_OPENED", url: session.page.currentUrl() });

    // 2. Guards: signature, expiry, origin lock (redirect away ⇒ reject), cap.
    assertPurchaseAllowed({
      checkpoint,
      mandate,
      quote,
      actualOrigin: originOf(session.page.currentUrl()),
      actualProvider: session.provider,
      lane: "slow",
      now: now(),
      ...(deps.mandateSecret === undefined ? {} : { mandateSecret: deps.mandateSecret }),
    });
    if (!deps.adapter.canHandle(session.page.currentUrl())) {
      throw new PurchaseFailedError(`Adapter '${deps.adapter.provider}' cannot handle ${session.page.currentUrl()}.`);
    }
    emit({ type: "PURCHASE_GUARDED" });

    // 3. Liveness probe BEFORE anything that matters (§15.2).
    const loggedIn = deps.adapter.ensureLoggedIn ? await deps.adapter.ensureLoggedIn(session.page) : undefined;
    if (stored || loggedIn !== undefined) {
      emit({
        type: "PROFILE_RESTORED",
        provider: mandate.provider,
        fromSavedProfile: stored !== undefined,
        dedicatedIp: session.profile?.dedicatedIpId !== undefined,
        loggedIn,
      });
    }
    if (loggedIn === false) {
      throw new PurchaseFailedError("Not authenticated with the vendor and re-authentication failed.", "NOT_AUTHENTICATED");
    }

    const key = purchaseKeyFor(mandate, requirement);
    const purchaseId = `pur_${mandate.mandateId}`;

    const resolveExisting = async (existing: PurchaseRecord): Promise<RecoveryResult> => {
      emit({ type: "PURCHASE_SKIPPED_DUPLICATE", purchaseId: existing.purchaseId, status: existing.status });
      if (existing.status === "PENDING") {
        throw new PurchaseInFlightError(`Purchase for key ${key} is already in progress.`);
      }
      const current = await readBalance();
      if (current.balance === undefined || current.balance < requirement.amount) {
        throw new PurchaseVerificationError(
          `A previous purchase attempt (${existing.status}) exists for this requirement but the balance ` +
            `(${current.balance ?? "unreadable"}) does not cover ${requirement.amount}. Not buying again; needs human review.`,
        );
      }
      if (existing.status !== "VERIFIED") await store.update(key, { status: "VERIFIED" });
      return finish({ ...current, balance: current.balance }, existing.purchaseId, false);
    };

    const existing = await store.get(key);
    if (blocksNewPurchase(existing)) return await resolveExisting(existing);

    // 4. Entitlement check. Also the Gate 2 baseline, so it must be readable.
    const before = await readBalance();
    if (before.balance === undefined) {
      throw new PurchaseFailedError(
        "Could not read the balance before purchasing; verification would be impossible, so nothing was bought.",
        "BALANCE_READ_FAILED",
      );
    }
    const balanceBefore = before.balance;
    emit({ type: "ENTITLEMENT_CHECKED", balance: balanceBefore, required: requirement.amount });
    if (balanceBefore >= requirement.amount) {
      emit({ type: "ALREADY_COVERED", balance: balanceBefore, required: requirement.amount });
      return await finish({ ...before, balance: balanceBefore }, null, true);
    }

    // 5. Discover offers and bind to the approved purchase.
    const offers = await runStep(
      () => deps.adapter.discoverOffers(session.page, requirement),
      "Open the pricing page and make the available credit packages visible.",
    );
    emit({ type: "OFFERS_DISCOVERED", count: offers.length });

    const offer = selectOffer(offers, mandate, requirement);
    if (!offer) {
      throw new PurchaseFailedError(
        `No one-time offer grants the required ${requirement.amount} ${requirement.resource}.`,
        "NO_VIABLE_OFFER",
      );
    }
    if (offer.price > quote.price || offer.price > mandate.maximumAmount) {
      throw new MandateRejectedError(
        `Selected price ${offer.price} exceeds the approved quote ${quote.price} or the mandate cap ${mandate.maximumAmount}.`,
        "AMOUNT_EXCEEDS_MANDATE",
      );
    }
    if (offer.currency !== mandate.currency) {
      throw new MandateRejectedError("Selected offer currency does not match the mandate.", "CURRENCY_MISMATCH");
    }
    emit({ type: "OFFER_SELECTED", productId: offer.productId, price: offer.price });

    // 6. Stage the checkout. Do not submit.
    const staged = await runStep(
      () => deps.adapter.stagePurchase(session.page, offer),
      `Select the '${offer.label}' package and proceed to the checkout page. Do not pay.`,
    );
    emit({
      type: "CHECKOUT_STAGED",
      lineItem: staged.lineItem,
      amount: staged.amount,
      currency: staged.currency,
      billingPeriod: staged.billingPeriod,
      autoRenew: staged.autoRenew,
    });

    // 7. GATE 1 — staged checkout vs signed mandate, field by field. Aborts before any spend.
    assertMatchesMandate(staged, mandate);
    emit({ type: "MANDATE_COMPARISON_PASSED", staged: staged.amount, cap: mandate.maximumAmount });

    if (deps.stopBeforeSubmit) {
      emit({ type: "SUBMIT_WITHHELD", staged: staged.amount, cap: mandate.maximumAmount });
      throw new SubmitWithheldError(
        "Checkout staged and matched the mandate, but real-money submit is not enabled for this vendor. Nothing was submitted.",
        {
          lineItem: staged.lineItem,
          amount: staged.amount,
          currency: staged.currency,
          billingPeriod: staged.billingPeriod,
          autoRenew: staged.autoRenew,
        },
      );
    }

    // 8. Claim the requirement and consume the single-use mandate.
    const claim = await store.claim({ idempotencyKey: key, mandateId: mandate.mandateId, purchaseId, status: "PENDING" });
    if (!claim.claimed) return await resolveExisting(claim.record);
    if (!(await store.consumeMandate(mandate.mandateId))) {
      await store.update(key, { status: "FAILED" });
      throw new MandateRejectedError(`Mandate ${mandate.mandateId} was already used.`, "MANDATE_ALREADY_USED");
    }

    // 9. Deterministic submit. Never the model path.
    emit({ type: "PURCHASE_STARTED", lane: "slow" });
    emit({ type: "PURCHASE_SUBMITTED" });
    try {
      const confirmation = await deps.adapter.confirmPurchase(session.page, staged);
      await store.update(key, {
        status: "SUBMITTED",
        ...(confirmation.transactionId === undefined ? {} : { transactionId: confirmation.transactionId }),
      });
      emit({ type: "PURCHASE_COMPLETED", transactionId: confirmation.transactionId });
    } catch (err) {
      if (err instanceof DeterministicStepError) {
        // The confirm control was never found, so nothing was submitted.
        await store.update(key, { status: "FAILED" });
        throw new PurchaseFailedError(
          `Confirm control not found; nothing was submitted. The final submit is never delegated to a model. (${err.message})`,
          "CONFIRM_NOT_FOUND",
        );
      }
      // From here money may have moved. Never retry; decide from observed state.
      await store.update(key, { status: "UNKNOWN" });
      if (err instanceof TakeoverRequiredError) {
        emit({ type: "TAKEOVER_REQUESTED", reason: err.message, sessionViewerUrl: session.sessionViewerUrl });
        if (!deps.onTakeover) throw err;
        await deps.onTakeover({
          session,
          taskId: checkpoint.taskId,
          reason: err.message,
          sessionViewerUrl: session.sessionViewerUrl,
        });
        emit({ type: "TAKEOVER_RESOLVED" });
      } else {
        emit({ type: "PURCHASE_RESULT_UNKNOWN", error: String(err) });
      }
    }

    // 10. GATE 2 — verify by reading the balance, not the receipt.
    const after = await readBalance();
    if (after.balance === undefined) {
      // Record stays SUBMITTED/UNKNOWN, which blocks any re-buy for this requirement.
      throw new PurchaseVerificationError("Could not read the balance after purchase; result unknown. Not retrying.");
    }
    // An unconfirmed balance keeps the record SUBMITTED/UNKNOWN, blocking a
    // second purchase even with a new mandate (same rule as the fast lane).
    // Only an explicit refusal — nothing submitted — may mark it FAILED.
    assertBalanceDelta(balanceBefore, after.balance, offer.unitsGranted);
    await store.update(key, {
      status: "VERIFIED",
      ...(after.transactionId === undefined ? {} : { transactionId: after.transactionId }),
    });
    emit({ type: "ENTITLEMENT_VERIFIED", before: balanceBefore, after: after.balance });

    return await finish({ ...after, balance: after.balance }, purchaseId, false);
  } finally {
    await session.close();
    emit({ type: "SESSION_CLOSED" });
    // Release starts the profile write. Don't hand back a verified result until
    // it lands, or the next recovery on this vendor restores stale state (§6).
    if (verifiedProfileId !== undefined && deps.provider.waitForProfileReady) {
      const status = await deps.provider.waitForProfileReady(verifiedProfileId).catch((): "ERROR" => "ERROR");
      emit({ type: "PROFILE_READY", provider: mandate.provider, status });
    }
  }
}
