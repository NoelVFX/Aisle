/**
 * Entitlement verification (aisle-pipeline.md §18 Gate 2).
 *
 * Checkout success is not entitlement success. The balance must have risen by
 * at least the units the mandate grants — not merely clear the requirement — so
 * a no-op checkout can't pass as a purchase.
 */

import { PurchaseVerificationError } from "../errors.js";

export function assertBalanceDelta(before: number, after: number, unitsGranted: number): void {
  const expected = before + unitsGranted;
  if (!Number.isFinite(after) || after < expected) {
    throw new PurchaseVerificationError(
      `Entitlement not confirmed: balance ${after} < expected ${expected} (before ${before} + ${unitsGranted}).`,
    );
  }
}
