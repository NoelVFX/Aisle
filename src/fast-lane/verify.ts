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

export async function verifyEntitlement(
  session: WebMcpSession,
  capability: FastLaneCapability,
  before: BalanceReading,
  quote: Quote,
): Promise<Entitlement> {
  const after = await readBalance(session, capability);

  const expected = before.balance + quote.purchase.credits;
  if (after.balance < expected) {
    throw new PurchaseVerificationError(
      `Entitlement not confirmed: balance ${after.balance} < expected ${expected} ` +
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
