/**
 * Recovery jobs for the gateway (aisle-pipeline.md §7–§12, §20).
 *
 *   open: freeze checkpoint (origin from upstreams.json) → quote → policy gate →
 *         signed mandate → AWAITING_APPROVAL
 *   approve (one human tap, signature-checked, idempotent) → Steel session on the
 *         LOCKED billing origin → outcome
 *
 * No real money moves in this gateway yet. After the Steel session:
 *   - a mock vendor is credited in-process (the docs' FAKE_PURCHASE=1), so the
 *     gateway can replay the blocked call and the agent continues;
 *   - a real vendor ends DRY_RUN_COMPLETE: Steel opened the billing page, nothing
 *     was bought, and the original call is not replayed.
 */

import { randomUUID } from "node:crypto";
import type { Blocker, PurchaseMandate, Quote, Refusal, TaskCheckpoint } from "../types.js";
import { freezeCheckpoint, lockOrigin } from "../core/checkpoint.js";
import { requirementHash } from "../core/hash.js";
import { buildQuote } from "../quote/quote.js";
import { gate, InMemorySpendLedger, loadLimits, type SpendLedger } from "../policy/policy.js";
import { signMandate, verifyMandate } from "../mandate/mandate.js";
import type { Upstreams } from "./upstreams.js";

export type JobStatus =
  | "awaiting_approval"
  | "running"
  | "resolved"
  | "dry_run_complete"
  | "refused"
  | "rejected"
  | "failed";

const OPEN: ReadonlySet<JobStatus> = new Set(["awaiting_approval", "running"]);

export interface TimelineEvent {
  at: string;
  type: string;
  detail: Record<string, unknown>;
}

/** What the Steel session did. Never carries a profileId. */
export interface SteelEvidence {
  sessionId: string;
  viewerUrl: string | undefined;
  finalUrl: string;
  title: string | undefined;
  screenshotPath: string | undefined;
}

export interface SteelRunner {
  run(input: {
    provider: string;
    billingOrigin: string;
    jobId: string;
    emit: (type: string, detail?: Record<string, unknown>) => void;
  }): Promise<SteelEvidence>;
}

export interface RecoveryJob {
  id: string;
  taskId: string;
  reqHash: string;
  namespace: string;
  status: JobStatus;
  checkpoint: TaskCheckpoint;
  quote?: Quote;
  mandate?: PurchaseMandate;
  refusal?: Refusal;
  remaining?: { task: number; day: number };
  approveUrl: string;
  steel?: SteelEvidence;
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
  /** Credit a mock vendor after the Steel session. Returns false for real vendors. */
  fakeCredit: (namespace: string, units: number) => boolean;
  publicUrl: () => string;
  spend?: SpendLedger;
  userId?: string;
  mandateSecret?: string;
  pollMs?: number;
  onEvent?: (job: RecoveryJob, event: TimelineEvent) => void;
  onApprovalRequested?: (job: RecoveryJob) => void;
}

export class RecoveryCoordinator {
  private readonly jobs = new Map<string, RecoveryJob>();
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

  private async execute(job: RecoveryJob): Promise<void> {
    const quote = job.quote!;
    try {
      this.emit(job, "PURCHASE_STARTED", { lane: "slow", mode: "no-real-money" });
      job.steel = await this.deps.steel.run({
        provider: job.namespace,
        billingOrigin: job.checkpoint.origin.billingOrigin,
        jobId: job.id,
        emit: (type, detail = {}) => this.emit(job, type, detail),
      });

      if (this.deps.fakeCredit(job.namespace, quote.unitsGranted)) {
        await this.spend.addSpend(job.taskId, this.userId, quote.price);
        this.emit(job, "PURCHASE_COMPLETED", { stub: true, amount: quote.price, units: quote.unitsGranted });
        this.emit(job, "ENTITLEMENT_VERIFIED", { units: quote.unitsGranted });
        job.status = "resolved";
      } else {
        this.emit(job, "PURCHASE_SKIPPED", { reason: "DRY_RUN: real purchases are not wired into the gateway" });
        job.status = "dry_run_complete";
      }
    } catch (err) {
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
