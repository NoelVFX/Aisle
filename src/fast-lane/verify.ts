/**
 * Entitlement verification.
 *
 * A completed checkout is NOT the same as a usable entitlement. We confirm the
 * balance actually rose by (at least) the quoted amount before issuing a resume
 * token. This prevents the worst state: the agent thinks it bought credits but
 * the task still can't run.
 */

import type { Entitlement, Quote } from "../types.js";
import type { WebMcpSession } from "../webmcp/session.js";
import type { FastLaneCapability } from "../webmcp/detector.js";
import { readBalance, type BalanceReading } from "./purchase.js";
import { PurchaseVerificationError } from "../errors.js";

export interface VerifyRetryOptions {
  /** Total balance reads to attempt, including the first. Must be >= 1. */
  attempts: number;
  /** Delay between attempts, for a vendor whose balance update is eventually consistent. */
  delayMsBetween: number;
}

export const DEFAULT_VERIFY_RETRY: VerifyRetryOptions = { attempts: 3, delayMsBetween: 200 };

export async function verifyEntitlement(
  session: WebMcpSession,
  capability: FastLaneCapability,
  before: BalanceReading,
  quote: Quote,
  retry: VerifyRetryOptions = DEFAULT_VERIFY_RETRY,
): Promise<Entitlement> {
  const attempts = Math.max(1, retry.attempts);
  const expected = before.balance + quote.purchase.credits;
  let after: BalanceReading | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    after = await readBalance(session, capability);
    assertComparable(before, after);
    if (after.balance >= expected) break;
    if (attempt < attempts) await sleep(retry.delayMsBetween);
  }

  if (!after || after.balance < expected) {
    throw new PurchaseVerificationError(
      `Entitlement not confirmed after ${attempts} check(s): balance ${after?.balance} < expected ${expected} ` +
        `(before ${before.balance} + ${quote.purchase.credits}).`,
    );
  }

  return {
    provider: capability.provider,
    accountId: after.accountId,
    resource: after.resource,
    balance: after.balance,
    status: "active",
    lastVerifiedAt: new Date().toISOString(),
  };
}

/**
 * Guard against the before/after delta being meaningless — e.g. the session
 * silently re-authenticated as a different account, or the balance tool
 * started reporting a different resource, between the two reads.
 */
function assertComparable(before: BalanceReading, after: BalanceReading): void {
  if (before.accountId !== "unknown" && after.accountId !== "unknown" && before.accountId !== after.accountId) {
    throw new PurchaseVerificationError(
      `Balance reads before/after purchase came from different accounts ` +
        `('${before.accountId}' vs '${after.accountId}'); refusing to trust the delta.`,
    );
  }
  if (before.resource !== after.resource) {
    throw new PurchaseVerificationError(
      `Balance resource type changed between reads ('${before.resource}' vs '${after.resource}'); ` +
        `refusing to trust the delta.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
