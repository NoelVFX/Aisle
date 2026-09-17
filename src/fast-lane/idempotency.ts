/**
 * Idempotency + single-use mandates (aisle-pipeline.md §11, §18, §20).
 *
 * "Did we buy?" must be answerable without buying again. A purchase record in
 * any state other than FAILED means money MAY have moved, so no new purchase is
 * attempted for that requirement — the lane re-reads the balance and decides
 * from observed state instead.
 *
 *   PENDING → SUBMITTED → VERIFIED
 *          ↘ UNKNOWN   → VERIFIED              (never back to SUBMITTED)
 *          ↘ FAILED     (the vendor explicitly refused; nothing was charged)
 */

import type { PurchaseMandate, Requirement } from "../types.js";
import { purchaseKey, requirementHash } from "../core/hash.js";

export type PurchaseStatus = "PENDING" | "SUBMITTED" | "UNKNOWN" | "VERIFIED" | "FAILED";

export interface PurchaseRecord {
  idempotencyKey: string;
  mandateId: string;
  purchaseId: string;
  status: PurchaseStatus;
  transactionId?: string;
}

export interface IdempotencyStore {
  get(key: string): Promise<PurchaseRecord | undefined>;
  /**
   * Claim the key for a new attempt. Succeeds only if no record exists or the
   * previous attempt is FAILED. Must be atomic in a durable implementation.
   */
  claim(record: PurchaseRecord): Promise<{ claimed: boolean; record: PurchaseRecord }>;
  update(key: string, patch: Partial<PurchaseRecord>): Promise<PurchaseRecord>;
  /**
   * Single-use mandate consumption. Returns true exactly once per mandateId.
   * Durable version: UPDATE mandates SET status='consumed'
   *                  WHERE id=$1 AND status='approved' RETURNING *
   * Zero rows → someone already used it → abort, do not purchase.
   */
  consumeMandate(mandateId: string): Promise<boolean>;
  /**
   * Drop a VERIFIED record once its recovery has been handed back. The purchase
   * is finished; a later shortfall of the same size in the same task is a new
   * need and must be able to buy again. Never call this for SUBMITTED/UNKNOWN.
   */
  forget(key: string): Promise<void>;
}

/** `purchase:{taskId}:{sha256(provider|resource|amount)}` — one purchase per shortfall. */
export function purchaseKeyFor(mandate: PurchaseMandate, requirement: Requirement): string {
  return purchaseKey(mandate.taskId, requirementHash(mandate.provider, requirement.resource, requirement.amount));
}

/** A record in one of these states means money may have moved: never buy again for it. */
export function blocksNewPurchase(record: PurchaseRecord | undefined): record is PurchaseRecord {
  return record !== undefined && record.status !== "FAILED";
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, PurchaseRecord>();
  private readonly consumed = new Set<string>();

  async get(key: string): Promise<PurchaseRecord | undefined> {
    return this.records.get(key);
  }

  async claim(record: PurchaseRecord): Promise<{ claimed: boolean; record: PurchaseRecord }> {
    const existing = this.records.get(record.idempotencyKey);
    if (blocksNewPurchase(existing)) return { claimed: false, record: existing };
    this.records.set(record.idempotencyKey, record);
    return { claimed: true, record };
  }

  async update(key: string, patch: Partial<PurchaseRecord>): Promise<PurchaseRecord> {
    const existing = this.records.get(key);
    if (!existing) throw new Error(`No purchase record for key ${key}`);
    const updated = { ...existing, ...patch };
    this.records.set(key, updated);
    return updated;
  }

  async consumeMandate(mandateId: string): Promise<boolean> {
    if (this.consumed.has(mandateId)) return false;
    this.consumed.add(mandateId);
    return true;
  }

  async forget(key: string): Promise<void> {
    if (this.records.get(key)?.status === "VERIFIED") this.records.delete(key);
  }
}
