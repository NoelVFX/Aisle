/**
 * Recovery jobs for the gateway (aisle-pipeline.md §7–§13, §18, §20).
 *
 *   open: freeze checkpoint (origin from upstreams.json / enrollment) → quote →
 *         policy gate → signed mandate → AWAITING_APPROVAL
 *   approve (one human tap, signature-checked, idempotent) → lane router (§13):
 *     1. fast lane: the vendor's MCP purchase tools, when configured and viable;
 *     2. slow lane: a real Steel browser stages the checkout with the click
 *        ladder, Gate 1, deterministic submit, Gate 2 — or, for a real-money
 *        vendor that isn't allowlisted, stops before submit;
 *     3. otherwise the Steel viewing session (open the billing page, no purchase).
 */

import { randomUUID } from "node:crypto";
import type { Entitlement } from "../types.js";
import type { Blocker, PurchaseMandate, Quote, RecoveryResult, Refusal, StagedCheckout, TaskCheckpoint } from "../types.js";
import { freezeCheckpoint, lockOrigin } from "../core/checkpoint.js";
import { requirementHash } from "../core/hash.js";
import { buildQuote } from "../quote/quote.js";
import { gate, InMemorySpendLedger, loadLimits, type SpendLedger } from "../policy/policy.js";
import { signMandate, verifyMandate } from "../mandate/mandate.js";
import type { UpstreamEntry, Upstreams } from "./upstreams.js";
import type { PurchaseOffer } from "../types.js";
// MO XIA's recovery flow: plan recommendation, customer selection, and the
// recovery session state machine, wired into every gateway recovery.
import { recommendCreditPlan, type CreditPlan, type PurchaseRecommendation } from "../recovery-flow/purchase-recommender.js";
import { selectPurchasePlan } from "../recovery-flow/customer-selection.js";
import {
  createRecoverySession,
  transitionRecoverySession,
  type RecoverySession,
  type RecoverySessionStatus,
} from "../recovery-flow/recovery-session.js";

const toPlan = (o: PurchaseOffer): CreditPlan => ({
  id: o.productId,
  name: o.label,
  credits: o.unitsGranted,
  price: o.price,
  currency: o.currency,
});

export type JobStatus =
  | "awaiting_approval"
  | "running"
  | "resolved"
  | "dry_run_complete"
  | "staged_not_submitted"
  | "refused"
  | "rejected"
  | "failed";

const OPEN: ReadonlySet<JobStatus> = new Set(["awaiting_approval", "running"]);

export interface TimelineEvent {
  at: string;
  type: string;
  detail: Record<string, unknown>;
}

/** A Steel session while it is open. Never carries a profileId. */
export interface SteelLive {
  sessionId: string;
  debugUrl: string | undefined;
  viewerUrl: string | undefined;
  /** A scoped human takeover is in progress: the viewer forwards input. */
  interactive?: boolean;
  /** Why, e.g. LOGIN_REQUIRED or a 3-D Secure challenge. */
  takeoverReason?: string;
}

export interface SteelEvidence extends SteelLive {
  finalUrl: string;
  title: string | undefined;
  screenshotPath: string | undefined;
}

export interface SteelRunner {
  run(input: {
    provider: string;
    billingOrigin: string;
    billingUrl: string;
    jobId: string;
    emit: (type: string, detail?: Record<string, unknown>) => void;
    onLive: (live: SteelLive) => void;
    hold: Promise<void>;
  }): Promise<SteelEvidence>;
}

export type SteelPurchaseOutcome =
  | { outcome: "verified"; result: RecoveryResult }
  | { outcome: "withheld"; staged: StagedCheckout };

/** Slow lane: a real Steel browser for an approved job. */
export interface SteelPurchaser {
  purchase(input: {
    job: RecoveryJob;
    upstream: UpstreamEntry;
    realMoneyAllowed: boolean;
    emit: (type: string, detail?: Record<string, unknown>) => void;
    onLive: (live: SteelLive) => void;
  }): Promise<SteelPurchaseOutcome>;
}

export type FastPurchaseOutcome =
  | { outcome: "verified"; result: RecoveryResult }
  /** No purchase was attempted: the vendor has no viable purchase tools or couldn't be reached. */
  | { outcome: "no_fast_lane"; reason: string };

/** Fast lane: the vendor's MCP purchase tools for an approved job. */
export interface FastPurchaser {
  purchase(input: {
    job: RecoveryJob;
    upstream: UpstreamEntry;
    emit: (type: string, detail?: Record<string, unknown>) => void;
  }): Promise<FastPurchaseOutcome>;
}

export interface RecoveryJob {
  id: string;
  taskId: string;
  reqHash: string;
  namespace: string;
  surface: "cli" | "web";
  status: JobStatus;
  lane?: "fast" | "slow" | "viewing";
  checkpoint: TaskCheckpoint;
  /** MO XIA's recovery session: every lifecycle step is a validated transition. */
  session: RecoverySession;
  /** MO XIA's recommendation: the recommended plan plus alternatives the customer may pick. */
  plans?: PurchaseRecommendation;
  selectedPlanId?: string;
  quote?: Quote;
  mandate?: PurchaseMandate;
  refusal?: Refusal;
  remaining?: { task: number; day: number };
  approveUrl: string;
  /** Web path: the user's live browsing session, whose context seeds the worker session. */
  workerContextFrom?: string;
  live?: SteelLive;
  steel?: SteelEvidence;
  staged?: StagedCheckout;
  purchase?: { purchaseId: string | null; balance: number | null; alreadyCovered: boolean };
  error?: string;
  events: TimelineEvent[];
  createdAt: string;
}

export interface OpenRecoveryInput {
  taskId: string;
  toolCallId: string;
  namespace: string;
  tool: string;
  arguments: unknown;
  blocker: Blocker;
  surface?: "cli" | "web";
  /** Web path: the browsing Steel session id (web-path.md §2.2). */
  workerContextFrom?: string;
}

export interface CoordinatorDeps {
  upstreams: Upstreams;
  steel: SteelRunner;
  publicUrl: () => string;
  /** Where the user approves; defaults to the per-recovery page /r/{id}. */
  approveUrlFor?: (recoveryId: string, surface: "cli" | "web") => string;
  /** Vendor balance APIs, read before quoting (§8) so a covered task is retried without buying. */
  balanceReaders?: Readonly<Record<string, () => Promise<number | undefined>>>;
  purchaser?: SteelPurchaser;
  fastPurchaser?: FastPurchaser;
  realPurchaseProviders?: ReadonlySet<string>;
  spend?: SpendLedger;
  userId?: string;
  mandateSecret?: string;
  pollMs?: number;
  onEvent?: (job: RecoveryJob, event: TimelineEvent) => void;
  onApprovalRequested?: (job: RecoveryJob) => void;
  onSteelLive?: (job: RecoveryJob) => void;
}

export class RecoveryCoordinator {
  private readonly jobs = new Map<string, RecoveryJob>();
  private readonly holds = new Map<string, () => void>();
  private readonly byRequirement = new Map<string, string>();
  private readonly approved = new Set<string>();
  private readonly spend: SpendLedger;
  private readonly userId: string;

  constructor(private readonly deps: CoordinatorDeps) {
    this.spend = deps.spend ?? new InMemorySpendLedger();
    this.userId = deps.userId ?? "local-user";
  }

  get(id: string): RecoveryJob | undefined {
    return this.jobs.get(id);
  }

  list(): RecoveryJob[] {
    return [...this.jobs.values()];
  }

  spendFor(taskId: string) {
    return this.spend.get(taskId, this.userId);
  }

  private emit(job: RecoveryJob, type: string, detail: Record<string, unknown> = {}): void {
    const event = { at: new Date().toISOString(), type, detail };
    job.events.push(event);
    this.deps.onEvent?.(job, event);
  }

  /** Open a recovery, or join the open one for the same (task, requirement). */
  async open(input: OpenRecoveryInput): Promise<RecoveryJob> {
    const upstream = this.deps.upstreams[input.namespace];
    if (!upstream) throw new Error(`UNKNOWN_UPSTREAM:${input.namespace}`);

    const blocker: Blocker =
      input.blocker.resource === "unknown" ? { ...input.blocker, resource: upstream.resource } : input.blocker;
    const reqHash = requirementHash(input.namespace, blocker.resource, blocker.required ?? 1);
    const key = `${input.taskId}:${reqHash}`;

    const existingId = this.byRequirement.get(key);
    const existing = existingId ? this.jobs.get(existingId) : undefined;
    if (existing && OPEN.has(existing.status)) {
      this.emit(existing, "RECOVERY_JOINED", { tool: input.tool });
      return existing;
    }

    const id = randomUUID();
    const surface = input.surface ?? "cli";
    const checkpoint = freezeCheckpoint({
      taskId: input.taskId,
      toolCallId: input.toolCallId,
      tool: input.tool,
      arguments: input.arguments,
      // FROM CONFIG / ENROLLMENT. Never from the error or the page.
      origin: lockOrigin(input.namespace, upstream, surface === "web" ? "enrollment" : "task_configuration"),
      blocker,
      surface,
    });
    const job: RecoveryJob = {
      id,
      taskId: input.taskId,
      reqHash,
      namespace: input.namespace,
      surface,
      status: "awaiting_approval",
      checkpoint,
      session: createRecoverySession(input.taskId),
      approveUrl: this.deps.approveUrlFor ? this.deps.approveUrlFor(id, surface) : `${this.deps.publicUrl()}/r/${id}`,
      ...(input.workerContextFrom ? { workerContextFrom: input.workerContextFrom } : {}),
      events: [],
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(id, job);
    this.byRequirement.set(key, id);

    this.emit(job, "RECOVERY_CREATED", { tool: input.tool, surface, blocker: blocker.type, resource: blocker.resource, required: blocker.required });
    this.emit(job, "CHECKPOINT_FROZEN", { billingOrigin: checkpoint.origin.billingOrigin, argumentsHash: checkpoint.argumentsHash });

    // Entitlement check (§8): re-read the vendor's balance before quoting. Covered → retry, no purchase.
    const reader = this.deps.balanceReaders?.[input.namespace];
    const observed = reader ? await reader().catch(() => undefined) : undefined;
    const current: Entitlement | null =
      observed === undefined
        ? null
        : {
            userId: this.userId,
            provider: input.namespace,
            accountId: null,
            resource: blocker.resource,
            balance: observed,
            plan: null,
            seatsUsed: null,
            seatsTotal: null,
            status: "active",
            verifiedAt: new Date().toISOString(),
          };
    if (reader) this.emit(job, "ENTITLEMENT_CHECKED", { balance: observed ?? null, required: blocker.required ?? 1, source: "vendor_api" });

    const limits = loadLimits();
    const outcome = buildQuote({ checkpoint, current, offers: [...upstream.offers], perPurchaseCeiling: limits.perPurchase });
    if (outcome.kind === "ALREADY_COVERED") {
      job.status = "resolved";
      this.emit(job, "ALREADY_COVERED", { balance: outcome.balance, required: outcome.required });
      return job;
    }
    if (outcome.kind !== "QUOTE") {
      job.status = "refused";
      job.refusal = {
        ok: false,
        reason: "NO_VIABLE_OFFER",
        detail: { ...outcome },
        message: "No one-time package under the per-purchase ceiling clears this shortfall.",
      };
      this.emit(job, "POLICY_REFUSED", { reason: "NO_VIABLE_OFFER" });
      return job;
    }
    job.quote = outcome.quote;
    this.emit(job, "QUOTE_CREATED", { price: outcome.quote.price, units: outcome.quote.unitsGranted, reason: outcome.quote.reason });

    const spend = await this.spend.get(input.taskId, this.userId);
    const verdict = gate(outcome.quote, checkpoint, spend, limits);
    if (!verdict.ok) {
      job.status = "refused";
      job.refusal = verdict;
      this.emit(job, "POLICY_REFUSED", { reason: verdict.reason, ...verdict.detail });
      return job;
    }
    job.remaining = { task: limits.perTask - spend.task, day: limits.perDay - spend.day };
    this.emit(job, "POLICY_PASSED", { remainingTask: job.remaining.task, remainingDay: job.remaining.day });

    // Plan recommendation (MO XIA): every one-time package under the per-purchase
    // ceiling that clears the shortfall. The docs' quote stays the recommended plan.
    const quoted = outcome.quote;
    const viable = upstream.offers.filter((o) => o.billing === "one_time" && o.autoRenew === false && o.price <= limits.perPurchase);
    try {
      const rec = recommendCreditPlan({ requiredCredits: Math.max(1, blocker.required ?? 1), plans: viable.map(toPlan) });
      const all = [rec.recommended, ...rec.alternatives];
      const primary = all.find((p) => p.id === quoted.productId) ?? rec.recommended;
      job.plans = { recommended: primary, alternatives: all.filter((p) => p.id !== primary.id) };
    } catch {
      const offer = upstream.offers.find((o) => o.productId === quoted.productId);
      job.plans = { recommended: offer ? toPlan(offer) : { id: quoted.productId, name: quoted.productId, credits: quoted.unitsGranted, price: quoted.price, currency: quoted.currency }, alternatives: [] };
    }
    job.selectedPlanId = job.plans.recommended.id;
    this.advance(job, "PLAN_RECOMMENDED");
    this.emit(job, "PLAN_RECOMMENDED", {
      recommended: job.plans.recommended.id,
      alternatives: job.plans.alternatives.map((p) => p.id),
    });
    this.advance(job, "CUSTOMER_SELECTED");

    job.mandate = signMandate(
      outcome.quote,
      { taskId: input.taskId, recoveryJobId: id, userId: this.userId },
      this.deps.mandateSecret === undefined ? {} : { secret: this.deps.mandateSecret },
    );
    this.emit(job, "MANDATE_SIGNED", { cap: job.mandate.maximumAmount, expiresAt: job.mandate.expiresAt });
    this.advance(job, "AWAITING_APPROVAL");
    this.emit(job, "APPROVAL_REQUESTED", { url: job.approveUrl });
    this.deps.onApprovalRequested?.(job);
    return job;
  }

  /** Move the job's recovery session. Invalid transitions throw, so no step can be skipped. */
  private advance(job: RecoveryJob, next: RecoverySessionStatus): void {
    job.session = transitionRecoverySession(job.session, next);
    this.emit(job, "SESSION_STATUS", { status: next });
  }

  /** Record a terminal session status on a failure path without masking the original error. */
  private advanceIfValid(job: RecoveryJob, next: RecoverySessionStatus): void {
    try {
      this.advance(job, next);
    } catch {
      // Already terminal or not yet purchasing; the job status carries the outcome.
    }
  }

  /**
   * Customer plan selection (MO XIA). Allowed until approval. The chosen plan is
   * re-checked against the policy gate and the mandate is re-signed, so approval
   * always binds exactly the plan on the card.
   */
  async selectPlan(id: string, planId: string): Promise<{ ok: boolean; error?: string }> {
    const job = this.jobs.get(id);
    if (!job?.plans || !job.quote || !job.mandate) return { ok: false, error: "NO_PLANS" };
    if (job.status !== "awaiting_approval" || this.approved.has(job.mandate.mandateId)) {
      return { ok: false, error: `JOB_${job.status.toUpperCase()}` };
    }
    let selection: ReturnType<typeof selectPurchasePlan>;
    try {
      selection = selectPurchasePlan(job.plans, planId);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (planId === job.selectedPlanId) return { ok: true };

    const offer = this.deps.upstreams[job.namespace]?.offers.find((o) => o.productId === planId);
    if (!offer) return { ok: false, error: "PLAN_NOT_IN_CATALOGUE" };
    const quote: Quote = {
      ...job.quote,
      productId: offer.productId,
      quantity: 1,
      unitsGranted: offer.unitsGranted,
      price: offer.price,
      currency: offer.currency,
      reason: selection.wasRecommended
        ? `Customer selected the recommended ${offer.label} at $${offer.price}.`
        : `Customer selected ${offer.label} at $${offer.price} instead of the recommended ${job.plans.recommended.name}.`,
    };

    const limits = loadLimits();
    const spend = await this.spend.get(job.taskId, this.userId);
    const verdict = gate(quote, job.checkpoint, spend, limits);
    if (!verdict.ok) return { ok: false, error: verdict.message };

    this.advance(job, "CUSTOMER_SELECTED");
    job.quote = quote;
    job.selectedPlanId = planId;
    job.remaining = { task: limits.perTask - spend.task, day: limits.perDay - spend.day };
    job.mandate = signMandate(
      quote,
      { taskId: job.taskId, recoveryJobId: job.id, userId: this.userId },
      this.deps.mandateSecret === undefined ? {} : { secret: this.deps.mandateSecret },
    );
    this.emit(job, "PLAN_SELECTED", { planId, price: offer.price, units: offer.unitsGranted, wasRecommended: selection.wasRecommended });
    this.emit(job, "MANDATE_SIGNED", { cap: job.mandate.maximumAmount, expiresAt: job.mandate.expiresAt });
    this.advance(job, "AWAITING_APPROVAL");
    return { ok: true };
  }

  /** POST /r/{id}/approve { mandate_signature }. Idempotent on approval:{mandateId}. */
  async approve(id: string, mandateSignature: string): Promise<{ ok: boolean; error?: string }> {
    const job = this.jobs.get(id);
    if (!job?.mandate) return { ok: false, error: "NO_MANDATE" };
    if (this.approved.has(job.mandate.mandateId)) return { ok: true };
    if (job.status !== "awaiting_approval") return { ok: false, error: `JOB_${job.status.toUpperCase()}` };
    if (mandateSignature !== job.mandate.signature) return { ok: false, error: "MANDATE_SIGNATURE_MISMATCH" };
    try {
      verifyMandate(job.mandate, this.deps.mandateSecret === undefined ? {} : { secret: this.deps.mandateSecret });
    } catch (err) {
      job.status = "failed";
      job.error = String((err as Error).message);
      this.emit(job, "APPROVAL_FAILED", { error: job.error });
      return { ok: false, error: job.error };
    }

    this.advance(job, "APPROVED");
    this.approved.add(job.mandate.mandateId);
    job.status = "running";
    this.emit(job, "APPROVAL_GRANTED");
    await this.spend.bumpAttempts(job.taskId);
    void this.execute(job);
    return { ok: true };
  }

  reject(id: string, reason?: string): { ok: boolean } {
    const job = this.jobs.get(id);
    if (!job || job.status !== "awaiting_approval") return { ok: false };
    job.status = "rejected";
    this.emit(job, "APPROVAL_REJECTED", reason ? { reason } : {});
    return { ok: true };
  }

  releaseSteel(id: string): boolean {
    const release = this.holds.get(id);
    if (!release) return false;
    this.holds.delete(id);
    release();
    return true;
  }

  private async execute(job: RecoveryJob): Promise<void> {
    const upstream = this.deps.upstreams[job.namespace];
    if (upstream?.purchase && (this.deps.purchaser || this.deps.fastPurchaser)) return this.executePurchase(job, upstream);
    return this.executeViewing(job);
  }

  /** Lane router (§13): fast lane when the vendor has purchase tools, else the Steel browser. */
  private async executePurchase(job: RecoveryJob, upstream: UpstreamEntry): Promise<void> {
    const quote = job.quote!;
    const realMoney = upstream.purchase?.realMoney ?? true;
    const realMoneyAllowed = !realMoney || (this.deps.realPurchaseProviders?.has(job.namespace) ?? false);

    const resolved = async (r: RecoveryResult) => {
      job.purchase = { purchaseId: r.purchaseId, balance: r.verifiedEntitlement.balance, alreadyCovered: r.alreadyCovered };
      if (!r.alreadyCovered) await this.spend.addSpend(job.taskId, this.userId, quote.price);
      this.advance(job, "PURCHASED");
      this.advance(job, "ENTITLEMENT_UPDATED");
      this.advance(job, "READY_TO_RESUME");
      job.status = "resolved";
    };

    try {
      this.advance(job, "PURCHASING");
      if (upstream.purchase?.mcpUrl && this.deps.fastPurchaser) {
        if (realMoneyAllowed) {
          job.lane = "fast";
          this.emit(job, "PURCHASE_STARTED", { lane: "fast", realMoney });
          const fast = await this.deps.fastPurchaser.purchase({ job, upstream, emit: (type, detail = {}) => this.emit(job, type, detail) });
          if (fast.outcome === "verified") return await resolved(fast.result);
          this.emit(job, "FAST_LANE_UNAVAILABLE", { reason: fast.reason });
        } else {
          this.emit(job, "FAST_LANE_SKIPPED", { reason: "real-money submit is not enabled for this vendor" });
        }
      }

      if (!this.deps.purchaser) {
        throw new Error("The vendor has no usable purchase tools and no Steel purchaser is configured (STEEL_API_KEY).");
      }
      job.lane = "slow";
      this.emit(job, "PURCHASE_STARTED", { lane: "slow", realMoney, submit: realMoneyAllowed ? "enabled" : "withheld" });
      const out = await this.deps.purchaser.purchase({
        job,
        upstream,
        realMoneyAllowed,
        emit: (type, detail = {}) => this.emit(job, type, detail),
        onLive: (live) => {
          job.live = live;
          this.deps.onSteelLive?.(job);
        },
      });
      job.live = undefined;

      if (out.outcome === "withheld") {
        job.staged = out.staged;
        this.advance(job, "PURCHASE_WITHHELD");
        job.status = "staged_not_submitted";
        return;
      }
      await resolved(out.result);
    } catch (err) {
      job.live = undefined;
      job.status = "failed";
      const code = (err as { code?: unknown }).code;
      // Unverified or in-flight purchases may have moved money: UNKNOWN, never FAILED.
      this.advanceIfValid(job, code === "PURCHASE_VERIFICATION_FAILED" || code === "PURCHASE_IN_FLIGHT" ? "PURCHASE_UNKNOWN" : "PURCHASE_FAILED");
      job.error = err instanceof Error ? err.message : String(err);
      if (code === "NOT_AUTHENTICATED") {
        job.error += ` Log the Steel profile in once with: npm run steel:login -- ${job.namespace}`;
      }
      this.emit(job, "RECOVERY_FAILED", { error: job.error, ...(typeof code === "string" ? { code } : {}) });
    }
  }

  private async executeViewing(job: RecoveryJob): Promise<void> {
    const upstream = this.deps.upstreams[job.namespace];
    const hold = new Promise<void>((resolve) => this.holds.set(job.id, resolve));
    job.lane = "viewing";
    try {
      this.advance(job, "PURCHASING");
      this.emit(job, "PURCHASE_STARTED", { lane: "viewing", mode: "no-real-money" });
      job.steel = await this.deps.steel.run({
        provider: job.namespace,
        billingOrigin: job.checkpoint.origin.billingOrigin,
        billingUrl: upstream?.billingUrl ?? job.checkpoint.origin.billingOrigin,
        jobId: job.id,
        emit: (type, detail = {}) => this.emit(job, type, detail),
        onLive: (live) => {
          job.live = live;
          this.deps.onSteelLive?.(job);
        },
        hold,
      });
      this.holds.delete(job.id);
      job.live = undefined;

      this.emit(job, "PURCHASE_SKIPPED", { reason: "DRY_RUN: this vendor has no purchase lane wired" });
      this.advance(job, "PURCHASE_WITHHELD");
      job.status = "dry_run_complete";
    } catch (err) {
      this.holds.delete(job.id);
      job.live = undefined;
      this.advanceIfValid(job, "PURCHASE_FAILED");
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      this.emit(job, "RECOVERY_FAILED", { error: job.error });
    }
  }

  async wait(id: string, timeoutMs: number, onChange?: (job: RecoveryJob) => Promise<void> | void): Promise<RecoveryJob> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`UNKNOWN_RECOVERY:${id}`);
    const deadline = Date.now() + timeoutMs;
    let seen = job.events.length;
    while (OPEN.has(job.status) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(this.deps.pollMs ?? 1000, Math.max(1, deadline - Date.now()))));
      if (job.events.length !== seen) {
        seen = job.events.length;
        await onChange?.(job);
      }
    }
    return job;
  }
}

export function isOpen(job: RecoveryJob): boolean {
  return OPEN.has(job.status);
}
