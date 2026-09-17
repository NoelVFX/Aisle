/**
 * Entitlement verification (aisle-pipeline.md §18 Gate 2).
 *
 * Checkout success is not entitlement success. The balance must have risen by
 * at least the units the mandate grants — not merely clear the requirement — so
 * a no-op checkout can't pass as a purchase.
 */

import { PurchaseVerificationError } from "../errors.js";
import type { WebMcpSession } from "../webmcp/session.js";
import type { FastLaneCapability } from "../webmcp/detector.js";
import { readBalance, type BalanceReading } from "./purchase.js";

export interface VerifyRetryOptions {
  /** Total balance reads, including the first. Must be a positive integer. */
  attempts: number;
  /** Delay between reads for eventually consistent vendors. */
  delayMsBetween: number;
}

export const DEFAULT_VERIFY_RETRY: VerifyRetryOptions = { attempts: 3, delayMsBetween: 200 };

export async function verifyBalanceDelta(
  session: WebMcpSession,
  capability: FastLaneCapability,
  before: BalanceReading,
  unitsGranted: number,
  retry: VerifyRetryOptions = DEFAULT_VERIFY_RETRY,
): Promise<BalanceReading> {
  if (!Number.isInteger(retry.attempts) || retry.attempts < 1 ||
      !Number.isFinite(retry.delayMsBetween) || retry.delayMsBetween < 0) {
    throw new PurchaseVerificationError("Invalid balance verification retry policy.");
  }
  for (let attempt = 1; ; attempt++) {
    const after = await readBalance(session, capability);
    if (before.accountId !== undefined && before.accountId !== after.accountId) {
      throw new PurchaseVerificationError("Balance reads came from different accounts; refusing to trust the delta.");
    }
    if (before.resource !== after.resource) {
      throw new PurchaseVerificationError("Balance resource type changed between reads; refusing to trust the delta.");
    }
    try {
      assertBalanceDelta(before.balance, after.balance, unitsGranted);
      return after;
    } catch (err) {
      if (attempt >= retry.attempts) throw err;
    }
    if (retry.delayMsBetween > 0) {
      await new Promise((resolve) => setTimeout(resolve, retry.delayMsBetween));
    }
  }
}

export function assertBalanceDelta(before: number, after: number, unitsGranted: number): void {
  const expected = before + unitsGranted;
  if (!Number.isFinite(after) || after < expected) {
    throw new PurchaseVerificationError(
      `Entitlement not confirmed: balance ${after} < expected ${expected} (before ${before} + ${unitsGranted}).`,
    );
  }
}
