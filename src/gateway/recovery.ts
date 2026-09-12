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
 *
 * Every change to a job is pushed to `subscribe()` listeners. The watch page and
 * the GUI widget are projections of that one stream (aisle-pipeline.md §12, §22).
 */

import { randomUUID } from "node:crypto";
import type { Blocker, PurchaseMandate, Quote, RecoveryResult, Refusal, StagedCheckout, TaskCheckpoint } from "../types.js";
import { freezeCheckpoint, lockOrigin } from "../core/checkpoint.js";
import { requirementHash } from "../core/hash.js";
import { buildQuote } from "../quote/quote.js";
import { gate, InMemorySpendLedger, loadLimits, type SpendLedger } from "../policy/policy.js";
import { signMandate, verifyMandate } from "../mandate/mandate.js";
import type { UpstreamEntry, Upstreams } from "./upstreams.js";
import { newAccessToken, watchUrl } from "./watch-access.js";

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

/** steel.md §16.3: how long a takeover waits for the human. */
export const DEFAULT_TAKEOVER_TIMEOUT_MS = 5 * 60_000;

export interface TimelineEvent {
  at: string;
  type: string;
  detail: Record<string, unknown>;
}

/** A Steel session while it is open. Never carries a profileId. */
export interface SteelLive {
  sessionId: string;
  /** Live player (embeddable). Unauthenticated by design: only the watch projection hands it out. */
  debugUrl: string | undefined;
  /** Steel dashboard page for the session. */
  viewerUrl: string | undefined;
}

/** A released Steel session, kept so the watch page can swap the live viewer for its replay. */
export interface SteelReplay {
  sessionId: string;
  viewerUrl: string | undefined;
  releasedAt: string;
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
    /**
     * A challenge only a human may clear (3-DS, OTP). Resolves when the user
     * hands the browser back from the watch page, or when the takeover times out;
     * the balance re-read then decides the outcome.
     */
    onTakeover: (reason: string) => Promise<void>;
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
  /** Capability for /r/{id}. Never put in an event, the timeline, or a persisted log. */
  accessToken: string;
  /** The watch + approval URL, token included. The CLI, the phone and the widget all open this one. */
  approveUrl: string;
  /** Set while a Steel session is open. */
  live?: SteelLive;
  /** The last released Steel session. */
  replay?: SteelReplay;
  /** A pending human takeover. The live viewer is interactive only while this is set. */
  takeover?: { reason: string; requestedAt: string; deadline: string };
  steel?: SteelEvidence;
  /** The checkout the slow lane staged (withheld or submitted). */
  staged?: StagedCheckout;
  purchase?: { purchaseId: string | null; balance: number | null; alreadyCovered: boolean };
  error?: string;
  events: TimelineEvent[];
  createdAt: string;
  /** When the job left the open states. The watch link expires relative to this. */
  finishedAt?: string;
}

/** `change` is set when the update is a new timeline event; `seq` is its index in `job.events`. */
export type JobListener = (job: RecoveryJob, change: { seq: number; event: TimelineEvent } | undefined) => void;

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
  /** How long a takeover waits for the human before handing back anyway. */
  takeoverTimeoutMs?: number;
  onEvent?: (job: RecoveryJob, event: TimelineEvent) => void;
  onApprovalRequested?: (job: RecoveryJob) => void;
  onSteelLive?: (job: RecoveryJob) => void;
}

export class RecoveryCoordinator {
  private readonly jobs = new Map<string, RecoveryJob>();
  private readonly holds = new Map<string, () => void>();
  private readonly takeovers = new Map<string, () => void>();
  private readonly listeners = new Map<string, Set<JobListener>>();
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

  /** Every change to one job: new events, live/replay swaps, takeovers, status. */
  subscribe(id: string, listener: JobListener): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  private notify(job: RecoveryJob, change?: { seq: number; event: TimelineEvent }): void {
    for (const listener of [...(this.listeners.get(job.id) ?? [])]) {
      try {
        listener(job, change);
      } catch {
        // A broken subscriber never breaks a recovery.
      }
    }
  }

  private emit(job: RecoveryJob, type: string, detail: Record<string, unknown> = {}): void {
    const event = { at: new Date().toISOString(), type, detail };
    job.events.push(event);
    // Both lanes announce the release; the viewer swaps to replay at once rather
    // than when the lane returns (the slow lane still waits for PROFILE_READY).
    if (type === "SESSION_CLOSED") this.endLive(job, false);
    this.deps.onEvent?.(job, event);
    this.notify(job, { seq: job.events.length - 1, event });
  }

  private setLive(job: RecoveryJob, live: SteelLive): void {
    // The purchaser reports live asynchronously; never resurrect a released session.
    if (job.replay?.sessionId === live.sessionId || !OPEN.has(job.status)) return;
    job.live = live;
    this.notify(job);
    this.deps.onSteelLive?.(job);
  }

  private endLive(job: RecoveryJob, notify = true): void {
    if (!job.live) return;
    job.replay = { sessionId: job.live.sessionId, viewerUrl: job.live.viewerUrl, releasedAt: new Date().toISOString() };
    job.live = undefined;
    if (notify) this.notify(job);
  }

  private finish(job: RecoveryJob, status: JobStatus): void {
    this.endLive(job, false);
    job.takeover = undefined;
    job.status = status;
    job.finishedAt = new Date().toISOString();
    this.emit(job, "RECOVERY_FINISHED", { status });
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
    const accessToken = newAccessToken();
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
      accessToken,
      approveUrl: watchUrl(this.deps.publicUrl(), { id, accessToken }),
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
      job.refusal = {
        ok: false,
        reason: "NO_VIABLE_OFFER",
        detail: { ...outcome },
        message: "No one-time package under the per-purchase ceiling clears this shortfall.",
      };
      this.emit(job, "POLICY_REFUSED", { reason: "NO_VIABLE_OFFER" });
      this.finish(job, "refused");
      return job;
    }
    job.quote = outcome.quote;
    this.emit(job, "QUOTE_CREATED", { price: outcome.quote.price, units: outcome.quote.unitsGranted, reason: outcome.quote.reason });

    const spend = await this.spend.get(input.taskId, this.userId);
    const verdict = gate(outcome.quote, checkpoint, spend, limits);
    if (!verdict.ok) {
      job.refusal = verdict;
      this.emit(job, "POLICY_REFUSED", { reason: verdict.reason, ...verdict.detail });
      this.finish(job, "refused");
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
    // The timeline carries the path only; the tokened URL goes to the user, not the log.
    this.emit(job, "APPROVAL_REQUESTED", { url: `${this.deps.publicUrl().replace(/\/+$/, "")}/r/${id}` });
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
      job.error = String((err as Error).message);
      this.emit(job, "APPROVAL_FAILED", { error: job.error });
      this.finish(job, "failed");
      return { ok: false, error: job.error };
    }

    this.approved.add(job.mandate.mandateId);
    job.status = "running";
    this.emit(job, "APPROVAL_GRANTED");
    await this.spend.bumpAttempts(job.taskId);
    void this.execute(job);
    return { ok: true };
  }

  /**
   * Approval from the watch page, which never sees the signature: the tokened
   * link authorizes the request, the mandate id binds it to the mandate shown.
   */
  async approveMandate(id: string, mandateId: string): Promise<{ ok: boolean; error?: string }> {
    const job = this.jobs.get(id);
    if (!job?.mandate) return { ok: false, error: "NO_MANDATE" };
    if (mandateId !== job.mandate.mandateId) return { ok: false, error: "MANDATE_ID_MISMATCH" };
    return this.approve(id, job.mandate.signature);
  }

  reject(id: string, reason?: string): { ok: boolean } {
    const job = this.jobs.get(id);
    if (!job || job.status !== "awaiting_approval") return { ok: false };
    this.emit(job, "APPROVAL_REJECTED", reason ? { reason } : {});
    this.finish(job, "rejected");
    return { ok: true };
  }

  /** End a held Steel viewing session early ("End session"). */
  releaseSteel(id: string): boolean {
    const release = this.holds.get(id);
    if (!release) return false;
    this.holds.delete(id);
    release();
    return true;
  }

  /** POST /r/{id}/takeover/done: the human cleared the challenge and hands the browser back. */
  completeTakeover(id: string): boolean {
    const handBack = this.takeovers.get(id);
    if (!handBack) return false;
    this.takeovers.delete(id);
    handBack();
    return true;
  }

  private async awaitTakeover(job: RecoveryJob, reason: string): Promise<void> {
    const timeoutMs = this.deps.takeoverTimeoutMs ?? DEFAULT_TAKEOVER_TIMEOUT_MS;
    const requestedAt = new Date();
    job.takeover = { reason, requestedAt: requestedAt.toISOString(), deadline: new Date(requestedAt.getTime() + timeoutMs).toISOString() };
    this.notify(job);

    const by = await new Promise<"user" | "timeout">((resolve) => {
      const timer = setTimeout(() => {
        this.takeovers.delete(job.id);
        resolve("timeout");
      }, timeoutMs);
      timer.unref?.();
      this.takeovers.set(job.id, () => {
        clearTimeout(timer);
        resolve("user");
      });
    });
    job.takeover = undefined;
    this.emit(job, "TAKEOVER_HANDED_BACK", { by });
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
        onLive: (live) => this.setLive(job, live),
        onTakeover: (reason) => this.awaitTakeover(job, reason),
      });

      if (out.outcome === "withheld") {
        job.staged = out.staged;
        this.finish(job, "staged_not_submitted");
        return;
      }
      const r = out.result;
      job.purchase = { purchaseId: r.purchaseId, balance: r.verifiedEntitlement.balance, alreadyCovered: r.alreadyCovered };
      if (!r.alreadyCovered) await this.spend.addSpend(job.taskId, this.userId, quote.price);
      this.finish(job, "resolved");
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      job.error = err instanceof Error ? err.message : String(err);
      if (code === "NOT_AUTHENTICATED") {
        job.error += ` Log the Steel profile in once with: npm run steel:login -- ${job.namespace}`;
      }
      this.emit(job, "RECOVERY_FAILED", { error: job.error, ...(typeof code === "string" ? { code } : {}) });
      this.finish(job, "failed");
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
        onLive: (live) => this.setLive(job, live),
        hold,
      });
      this.holds.delete(job.id);

      if (this.deps.fakeCredit(job.namespace, quote.unitsGranted)) {
        await this.spend.addSpend(job.taskId, this.userId, quote.price);
        this.emit(job, "PURCHASE_COMPLETED", { stub: true, amount: quote.price, units: quote.unitsGranted });
        this.emit(job, "ENTITLEMENT_VERIFIED", { units: quote.unitsGranted });
        this.finish(job, "resolved");
      } else {
        this.emit(job, "PURCHASE_SKIPPED", { reason: "DRY_RUN: this vendor has no slow-lane purchase wired" });
        this.finish(job, "dry_run_complete");
      }
    } catch (err) {
      this.holds.delete(job.id);
      job.error = err instanceof Error ? err.message : String(err);
      this.emit(job, "RECOVERY_FAILED", { error: job.error });
      this.finish(job, "failed");
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
