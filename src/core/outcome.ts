/** Shared helpers both lanes use to converge on the same `RecoveryResult`. */

import type {
  Entitlement,
  PurchaseMandate,
  RecoveryRequest,
  RecoveryResult,
  Requirement,
} from "../types.js";
import { requirementFor } from "./checkpoint.js";
import { buildResumeToken } from "../resume/resume-token.js";

export function resolveRequirement(request: RecoveryRequest): Requirement {
  return request.requirement ?? requirementFor(request.checkpoint, request.quote.unitsGranted);
}

export function makeEntitlement(
  mandate: PurchaseMandate,
  reading: { balance: number; accountId?: string | undefined; resource: string },
  now: Date,
): Entitlement {
  return {
    userId: mandate.userId,
    provider: mandate.provider,
    accountId: reading.accountId ?? null,
    resource: reading.resource,
    balance: reading.balance,
    plan: null,
    seatsUsed: null,
    seatsTotal: null,
    status: "active",
    verifiedAt: now.toISOString(),
  };
}

export function makeResult(args: {
  lane: RecoveryResult["lane"];
  purchaseId: string | null;
  entitlement: Entitlement;
  request: RecoveryRequest;
  requirement: Requirement;
  alreadyCovered: boolean;
  now: Date;
}): RecoveryResult {
  return {
    lane: args.lane,
    purchaseId: args.purchaseId,
    verifiedEntitlement: args.entitlement,
    resumeToken: buildResumeToken(args.request.checkpoint, args.entitlement, args.requirement.amount, args.now),
    alreadyCovered: args.alreadyCovered,
  };
}
