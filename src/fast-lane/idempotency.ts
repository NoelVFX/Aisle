/**
 * Idempotency — the single most important safety property of the purchase
 * path. A WebMCP call can complete on the vendor side while the response is
 * lost in transit — or a host can retry while the first attempt is still
 * running. Before we ever call the purchase tool, we must be able to answer
 * "did we already claim this, and is that claim still live?" without ever
 * launching two purchases for the same requirement at once.
 */

import type { PurchaseMandate, Quote } from "../types.js";

export interface PurchaseRecord {
  idempotencyKey: string;
  mandateId: string;
  purchaseId: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  transactionId?: string;
}

export interface PutIfAbsentResult {
  record: PurchaseRecord;
  /**
   * True only for the caller that actually created the record — i.e. the one
   * that now owns this purchase attempt. Every other concurrent or later
   * caller gets `created: false` with the record as it currently stands, so
   * they can tell an in-flight claim (`status: "PENDING"`, not theirs) apart
   * from a genuinely new one.
   */
  created: boolean;
}

/**
 * Minimal persistence contract. The in-memory implementation is fine for the
 * demo; back it with Postgres/Redis for anything durable. A durable
 * implementation MUST make `putIfAbsent` atomic (e.g. an `INSERT ... ON
 * CONFLICT DO NOTHING RETURNING *`) — a check-then-set built from separate
 * `get` + `put` calls reintroduces the exact race this interface exists to
 * close.
 */
export interface IdempotencyStore {
  get(key: string): Promise<PurchaseRecord | undefined>;
  /** Create the record only if absent. Reports whether THIS call created it. */
  putIfAbsent(record: PurchaseRecord): Promise<PutIfAbsentResult>;
  update(key: string, patch: Partial<PurchaseRecord>): Promise<PurchaseRecord>;
}

/** Stable key: one purchase per (task, exact requirement). */
export function purchaseKey(mandate: PurchaseMandate, quote: Quote): string {
  const requirement = `${quote.purchase.productId}:${quote.purchase.quantity}:${quote.purchase.credits}`;
  return `purchase:${mandate.taskId}:${hash(requirement)}`;
}

/** Tiny, dependency-free string hash (djb2). Not cryptographic. */
function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (h * 33) ^ input.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, PurchaseRecord>();

  async get(key: string): Promise<PurchaseRecord | undefined> {
    return this.records.get(key);
  }

  async putIfAbsent(record: PurchaseRecord): Promise<PutIfAbsentResult> {
    const existing = this.records.get(record.idempotencyKey);
    if (existing) return { record: existing, created: false };
    this.records.set(record.idempotencyKey, record);
    return { record, created: true };
  }

  async update(key: string, patch: Partial<PurchaseRecord>): Promise<PurchaseRecord> {
    const existing = this.records.get(key);
    if (!existing) throw new Error(`No purchase record for key ${key}`);
    const updated = { ...existing, ...patch };
    this.records.set(key, updated);
    return updated;
  }
}
