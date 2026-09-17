/**
 * Policy gate (aisle-pipeline.md §10). Runs before a mandate is ever signed.
 *
 *   1. origin lock  2. per purchase  3. per task  4. per day  5. circuit breaker
 *
 * A refusal always reports cumulative spend and goes back to the agent as a
 * normal tool result, so the agent can tell the user something useful.
 */

import type { GateResult, Limits, Quote, Refusal, SpendState, TaskCheckpoint } from "../types.js";

const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/** Defaults: $50 / $100 / $250, 3 purchase attempts, 5 resolver calls. */
export function loadLimits(): Limits {
  return {
    perPurchase: envNumber("LIMIT_PER_PURCHASE", 50),
    perTask: envNumber("LIMIT_PER_TASK", 100),
    perDay: envNumber("LIMIT_PER_DAY", 250),
    maxAttemptsPerTask: envNumber("MAX_PURCHASE_ATTEMPTS_PER_TASK", 3),
    maxResolverCallsPerJob: envNumber("MAX_RESOLVER_CALLS_PER_JOB", 5),
  };
}

const DEFAULT_PORTS: Record<string, string> = { "https:": "443", "http:": "80" };

/**
 * Do not write === on raw origin strings and call it an origin lock.
 * Scheme, host case, default port, path and trailing slash all normalize.
 * Throws on anything that isn't a parseable absolute URL.
 */
export function canonicalize(origin: string): string {
  const u = new URL(origin.trim());
  const protocol = u.protocol.toLowerCase();
  const port = u.port && u.port !== DEFAULT_PORTS[protocol] ? `:${u.port}` : "";
  return `${protocol}//${u.hostname.toLowerCase()}${port}`;
}

/** True when both parse and canonicalize to the same origin. Never throws. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

function refuse(reason: Refusal["reason"], detail: Record<string, unknown>, message: string): Refusal {
  return { ok: false, reason, detail, message };
}

export function gate(
  quote: Quote,
  checkpoint: TaskCheckpoint,
  spend: SpendState,
  limits: Limits = loadLimits(),
): GateResult {
  // 1. ORIGIN LOCK — hard boundary, checked first, always.
  let attempted: string;
  let authorized: string;
  try {
    attempted = canonicalize(quote.billingOrigin);
    authorized = canonicalize(checkpoint.origin.billingOrigin);
  } catch {
    return refuse(
      "ORIGIN_VIOLATION",
      { attempted: quote.billingOrigin, authorized: checkpoint.origin.billingOrigin, cumulative: spend.task },
      "Purchase blocked. The purchase origin could not be parsed.",
    );
  }
  if (attempted !== authorized) {
    return refuse(
      "ORIGIN_VIOLATION",
      { attempted, authorized, cumulative: spend.task },
      `Purchase blocked. ${attempted} is not authorized by this task. Authorized origin is ${authorized}.`,
    );
  }

  if (!Number.isFinite(quote.price) || quote.price < 0) {
    return refuse(
      "PER_PURCHASE_CEILING",
      { requested: quote.price, ceiling: limits.perPurchase, cumulative: spend.task },
      "Purchase blocked. The quoted price is not a valid amount.",
    );
  }

  // 2. per purchase
  if (quote.price > limits.perPurchase) {
    return refuse(
      "PER_PURCHASE_CEILING",
      { requested: quote.price, ceiling: limits.perPurchase, cumulative: spend.task },
      `Purchase blocked. $${quote.price} exceeds the $${limits.perPurchase} per-purchase ceiling.`,
    );
  }

  // 3. per task
  if (spend.task + quote.price > limits.perTask) {
    const remaining = limits.perTask - spend.task;
    return refuse(
      "PER_TASK_CEILING",
      { cumulative: spend.task, requested: quote.price, remaining, ceiling: limits.perTask },
      `Purchase blocked. You have spent $${spend.task} on this task; $${quote.price} would take it to ` +
        `$${spend.task + quote.price}, over the $${limits.perTask} ceiling. $${remaining} remaining.`,
    );
  }

  // 4. per day
  if (spend.day + quote.price > limits.perDay) {
    const remaining = limits.perDay - spend.day;
    return refuse(
      "PER_DAY_CEILING",
      { cumulative: spend.day, requested: quote.price, remaining, ceiling: limits.perDay },
      `Purchase blocked. You have spent $${spend.day} today; $${quote.price} would exceed the ` +
        `$${limits.perDay} daily ceiling. $${remaining} remaining.`,
    );
  }

  // 5. circuit breaker
  if (spend.attempts >= limits.maxAttemptsPerTask) {
    return refuse(
      "CIRCUIT_OPEN",
      { attempts: spend.attempts, cumulative: spend.task },
      `Purchase blocked. ${spend.attempts} purchase attempts already made on this task ` +
        `($${spend.task} spent).`,
    );
  }

  return { ok: true };
}

/** Spend state keyed as in the `spend_state` table: `task:{id}` and `day:{user}:{yyyy-mm-dd}`. */
export interface SpendLedger {
  get(taskId: string, userId: string, now?: Date): Promise<SpendState>;
  addSpend(taskId: string, userId: string, amount: number, now?: Date): Promise<void>;
  bumpAttempts(taskId: string): Promise<void>;
}

export class InMemorySpendLedger implements SpendLedger {
  private readonly amounts = new Map<string, number>();
  private readonly attempts = new Map<string, number>();

  private static day(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  async get(taskId: string, userId: string, now: Date = new Date()): Promise<SpendState> {
    return {
      task: this.amounts.get(`task:${taskId}`) ?? 0,
      day: this.amounts.get(`day:${userId}:${InMemorySpendLedger.day(now)}`) ?? 0,
      attempts: this.attempts.get(`task:${taskId}`) ?? 0,
    };
  }

  async addSpend(taskId: string, userId: string, amount: number, now: Date = new Date()): Promise<void> {
    const taskKey = `task:${taskId}`;
    const dayKey = `day:${userId}:${InMemorySpendLedger.day(now)}`;
    this.amounts.set(taskKey, (this.amounts.get(taskKey) ?? 0) + amount);
    this.amounts.set(dayKey, (this.amounts.get(dayKey) ?? 0) + amount);
  }

  async bumpAttempts(taskId: string): Promise<void> {
    const key = `task:${taskId}`;
    this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
  }
}
