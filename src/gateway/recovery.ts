/**
 * Recovery jobs for the gateway (aisle-pipeline.md §7–§12, §13, §18, §20).
 *
 *   open: freeze checkpoint (origin from upstreams.json) → quote → policy gate →
 *         signed mandate → AWAITING_APPROVAL
 *   approve (one human tap, signature-checked, idempotent) → lane:
 *     - slow lane (vendor has `purchase` config and a purchaser is wired): real
 *       Steel browser stages the checkout with the click ladder, Gate 1, then a
 *       deterministic submit and Gate 2 — or, for a real-money vendor that isn't
 *       allowlisted, stops before submit (STAGED_NOT_SUBMITTED);
 *     - otherwise the Steel viewing session: open the billing page, credit an
 *       in-process mock (FAKE_PURCHASE), or end DRY_RUN_COMPLETE.
 */

import { randomUUID } from "node:crypto";
import type { Blocker, PurchaseMandate, Quote, RecoveryResult, Refusal, StagedCheckout, TaskCheckpoint } from "../types.js";
import { freezeCheckpoint, lockOrigin } from "../core/checkpoint.js";
import { requirementHash } from "../core/hash.js";
import { buildQuote } from "../quote/quote.js";
import { gate, InMemorySpendLedger, loadLimits, type SpendLedger } from "../policy/policy.js";
import { signMandate, verifyMandate } from "../mandate/mandate.js";
import type { UpstreamEntry, Upstreams } from "./upstreams.js";

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
  /** Live player (embeddable). */
  debugUrl: string | undefined;
  /** Steel dashboard page for the session. */
  viewerUrl: string | undefined;
}

/** What the Steel viewing session did. Never carries a profileId. */
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
    /** Resolves when the user ends the session from the approval page. */
    hold: Promise<void>;
  }): Promise<SteelEvidence>;
}

export type SteelPurchaseOutcome =
  | { outcome: "verified"; result: RecoveryResult }
  | { outcome: "withheld"; staged: StagedCheckout };

/** Runs the slow lane in a real Steel browser for an approved job. */
export interface SteelPurchaser {
  purchase(input: {
    job: RecoveryJob;
    upstream: UpstreamEntry;
    /** False for a real-money vendor that isn't allowlisted: stage + Gate 1, never submit. */
    realMoneyAllowed: boolean;
    emit: (type: string, detail?: Record<string, unknown>) => void;
    onLive: (live: SteelLive) => void;
  }): Promise<SteelPurchaseOutcome>;
}

export interface RecoveryJob {
  id: string;
  taskId: string;
  reqHash: string;
  namespace: string;
  status: JobStatus;
  lane?: "slow" | "viewing";
  checkpoint: TaskCheckpoint;
  quote?: Quote;
  mandate?: PurchaseMandate;
  refusal?: Refusal;
  remaining?: { task: number; day: number };
  approveUrl: string;
  /** Set while a Steel session is open. */
  live?: SteelLive;
  steel?: SteelEvidence;
  /** The checkout the slow lane staged (withheld or submitted). */
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
}

export interface CoordinatorDeps {
  upstreams: Upstreams;
  steel: SteelRunner;
  /** Credit an in-process mock vendor after the viewing session. False for real vendors. */
  fakeCredit: (namespace: string, units: number) => boolean;
  publicUrl: () => string;
  /** Slow-lane purchaser. Without it every approval runs the viewing session. */
  purchaser?: SteelPurchaser;
  /** Real-money vendors allowed to actually submit (AISLE_REAL_PURCHASE_PROVIDERS). */
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
    const checkpoint = freezeCheckpoint({
      taskId: input.taskId,
      toolCallId: input.toolCallId,
      tool: input.tool,
      arguments: input.arguments,
      origin: lockOrigin(input.namespace, upstream), // FROM CONFIG. Never from the error.
      blocker,
    });
    const job: RecoveryJob = {
      id,
      taskId: input.taskId,
      reqHash,
      namespace: input.namespace,
      status: "awaiting_approval",
      checkpoint,
      approveUrl: `${this.deps.publicUrl()}/r/${id}`,
      events: [],
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(id, job);
    this.byRequirement.set(key, id);

    this.emit(job, "RECOVERY_CREATED", { tool: input.tool, blocker: blocker.type, resource: blocker.resource, required: blocker.required });
    this.emit(job, "CHECKPOINT_FROZEN", { billingOrigin: checkpoint.origin.billingOrigin, argumentsHash: checkpoint.argumentsHash });

    const limits = loadLimits();
    const outcome = buildQuote({ checkpoint, current: null, offers: [...upstream.offers], perPurchaseCeiling: limits.perPurchase });
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

    job.mandate = signMandate(
      outcome.quote,
      { taskId: input.taskId, recoveryJobId: id, userId: this.userId },
      this.deps.mandateSecret === undefined ? {} : { secret: this.deps.mandateSecret },
    );
    this.emit(job, "MANDATE_SIGNED", { cap: job.mandate.maximumAmount, expiresAt: job.mandate.expiresAt });
    this.emit(job, "APPROVAL_REQUESTED", { url: job.approveUrl });
    this.deps.onApprovalRequested?.(job);
    return job;
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

  /** End a held Steel viewing session early ("End Steel session"). */
  releaseSteel(id: string): boolean {
    const release = this.holds.get(id);
    if (!release) return false;
    this.holds.delete(id);
    release();
    return true;
  }

  private async execute(job: RecoveryJob): Promise<void> {
    const upstream = this.deps.upstreams[job.namespace];
    if (upstream?.purchase && this.deps.purchaser) return this.executeSlowLane(job, upstream);
    return this.executeViewing(job);
  }

  private async executeSlowLane(job: RecoveryJob, upstream: UpstreamEntry): Promise<void> {
    const quote = job.quote!;
    const realMoney = upstream.purchase?.realMoney ?? true;
    const realMoneyAllowed = !realMoney || (this.deps.realPurchaseProviders?.has(job.namespace) ?? false);
    job.lane = "slow";
    try {
      this.emit(job, "PURCHASE_STARTED", { lane: "slow", realMoney, submit: realMoneyAllowed ? "enabled" : "withheld" });
      const out = await this.deps.purchaser!.purchase({
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
        job.status = "staged_not_submitted";
        return;
      }
      const r = out.result;
      job.purchase = { purchaseId: r.purchaseId, balance: r.verifiedEntitlement.balance, alreadyCovered: r.alreadyCovered };
      if (!r.alreadyCovered) await this.spend.addSpend(job.taskId, this.userId, quote.price);
      job.status = "resolved";
    } catch (err) {
      job.live = undefined;
      job.status = "failed";
      const code = (err as { code?: unknown }).code;
      job.error = err instanceof Error ? err.message : String(err);
      if (code === "NOT_AUTHENTICATED") {
        job.error += ` Log the Steel profile in once with: npm run steel:login -- ${job.namespace}`;
      }
      this.emit(job, "RECOVERY_FAILED", { error: job.error, ...(typeof code === "string" ? { code } : {}) });
    }
  }

  private async executeViewing(job: RecoveryJob): Promise<void> {
    const quote = job.quote!;
    const upstream = this.deps.upstreams[job.namespace];
    const hold = new Promise<void>((resolve) => this.holds.set(job.id, resolve));
    job.lane = "viewing";
    try {
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

      if (this.deps.fakeCredit(job.namespace, quote.unitsGranted)) {
        await this.spend.addSpend(job.taskId, this.userId, quote.price);
        this.emit(job, "PURCHASE_COMPLETED", { stub: true, amount: quote.price, units: quote.unitsGranted });
        this.emit(job, "ENTITLEMENT_VERIFIED", { units: quote.unitsGranted });
        job.status = "resolved";
      } else {
        this.emit(job, "PURCHASE_SKIPPED", { reason: "DRY_RUN: this vendor has no slow-lane purchase wired" });
        job.status = "dry_run_complete";
      }
    } catch (err) {
      this.holds.delete(job.id);
      job.live = undefined;
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      this.emit(job, "RECOVERY_FAILED", { error: job.error });
    }
  }

  /** Block until the job leaves the open states or the deadline passes. */
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
