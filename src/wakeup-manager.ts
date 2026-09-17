import type { FailureClassification, FailureEvent } from "./event.js";
import { RECOVERABLE_BLOCKERS } from "./classifier.js";
import { requirementHash, sha256 } from "./core/hash.js";
import { InfraBlockedError } from "./errors.js";

export interface WakeUpHandler {
  wake(event: FailureEvent): Promise<void>;
}

export interface WakeUpManagerOptions {
  /**
   * sha256 fingerprints of API keys that belong to Aisle's own infrastructure.
   * Defaults to the fingerprint of process.env.OPENROUTER_INFRA_KEY (§16.5).
   * Keyed on KEY IDENTITY, not provider name: "openrouter" is both things.
   */
  nonRecoverableKeyFingerprints?: Iterable<string>;
  /** Emit INFRA_CREDITS_EXHAUSTED on the timeline before failing loud. */
  onInfraBlocked?: (event: FailureEvent) => void;
  log?: (message: string) => void;
}

/** Fingerprint an API key for the infra exclusion list. Never store the key itself. */
export function fingerprintKey(apiKey: string): string {
  return sha256(apiKey);
}

const DEFAULT_RESOURCE: Partial<Record<FailureClassification, string>> = {
  INSUFFICIENT_CREDITS: "credits",
  QUOTA_EXCEEDED: "quota",
  PLAN_REQUIRED: "plan",
  SEAT_REQUIRED: "seats",
  PAYMENT_REQUIRED: "unknown",
};

export class WakeUpManager {
  /**
   * One recovery per (task, requirement) — the same idempotency the spec
   * enforces with UNIQUE (task_id, req_hash). An agent retrying the blocked
   * call, or a second surface seeing the same shortfall, joins the existing
   * recovery instead of opening another.
   */
  private readonly awakenedFailures = new Set<string>();
  private readonly infraFingerprints: Set<string>;
  private readonly log: (message: string) => void;

  constructor(
    private readonly handler: WakeUpHandler,
    private readonly options: WakeUpManagerOptions = {},
  ) {
    const infraKey = process.env["OPENROUTER_INFRA_KEY"];
    this.infraFingerprints = new Set(
      options.nonRecoverableKeyFingerprints ?? (infraKey ? [fingerprintKey(infraKey)] : []),
    );
    this.log = options.log ?? ((m) => console.log(m));
  }

  async handle(event: FailureEvent): Promise<void> {
    if (!RECOVERABLE_BLOCKERS.has(event.errorType)) {
      this.log(`[Aisle] Ignoring non-recoverable failure: ${event.errorType}`);
      return;
    }

    // The recovery layer cannot recover itself. Fail loud; never open a job.
    if (event.credentialFingerprint !== undefined && this.infraFingerprints.has(event.credentialFingerprint)) {
      this.options.onInfraBlocked?.(event);
      throw new InfraBlockedError();
    }

    const wakeKey = this.wakeKeyFor(event);
    if (this.awakenedFailures.has(wakeKey)) {
      this.log(`[Aisle] Recovery already in progress for this requirement: ${wakeKey}`);
      return;
    }
    this.awakenedFailures.add(wakeKey);
    this.log(`[Aisle] Recoverable payment failure detected: ${event.errorType}`);

    try {
      await this.handler.wake(event);
    } catch (error) {
      // The handler failed before completing: allow another attempt.
      this.awakenedFailures.delete(wakeKey);
      throw error;
    }
  }

  /**
   * Call once recovery has resolved (verified or refused) so a LATER shortfall
   * of the same shape in the same task can wake recovery again.
   */
  markResolved(event: FailureEvent): void {
    this.awakenedFailures.delete(this.wakeKeyFor(event));
  }

  /** `{taskId}:{requirementHash(provider, resource, amount)}` */
  wakeKeyFor(event: FailureEvent): string {
    const resource = event.blocker?.resource ?? DEFAULT_RESOURCE[event.errorType] ?? "unknown";
    const amount = event.blocker?.required ?? 1;
    return `${event.taskId}:${requirementHash(event.provider, resource, amount)}`;
  }
}
