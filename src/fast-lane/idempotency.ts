/**
 * Idempotency — the single most important safety property of the purchase
 * path. A WebMCP call can complete on the vendor side while the response is
 * lost in transit. Before we ever retry, we must be able to answer "did we
 * already buy?" without buying again.
 */

import type { PurchaseMandate, Quote } from "../types.js";

export interface PurchaseRecord {
  idempotencyKey: string;
  mandateId: string;
  purchaseId: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  transactionId?: string;
}

/**
 * Minimal persistence contract. The in-memory implementation is fine for the
 * demo; back it with Postgres/Redis for anything durable.
 */
export interface IdempotencyStore {
  get(key: string): Promise<PurchaseRecord | undefined>;
  /** Create the record only if absent. Returns the existing one if present. */
  putIfAbsent(record: PurchaseRecord): Promise<PurchaseRecord>;
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

  async putIfAbsent(record: PurchaseRecord): Promise<PurchaseRecord> {
    const existing = this.records.get(record.idempotencyKey);
    if (existing) return existing;
    this.records.set(record.idempotencyKey, record);
    return record;
  }

  async update(key: string, patch: Partial<PurchaseRecord>): Promise<PurchaseRecord> {
    const existing = this.records.get(key);
    if (!existing) throw new Error(`No purchase record for key ${key}`);
    const updated = { ...existing, ...patch };
    this.records.set(key, updated);
    return updated;
  }
}
