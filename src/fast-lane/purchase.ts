/**
 * Purchase execution via the vendor's purchase tool (aisle-pipeline.md §14).
 *
 * The arguments are derived ONLY from the signed mandate — never from tool
 * output, page content, or anything the vendor said.
 */

import type { PurchaseMandate } from "../types.js";
import type { WebMcpSession } from "../webmcp/session.js";
import type { FastLaneCapability } from "../webmcp/detector.js";
import { PurchaseFailedError } from "../errors.js";

export interface BalanceReading {
  balance: number;
  accountId: string | undefined;
  /** The resource the vendor says this balance is for; undefined when it doesn't say. */
  resource: string | undefined;
}

export interface PurchaseOutcome {
  transactionId: string | undefined;
  raw: Record<string, unknown> | undefined;
}

/** Read the vendor's current balance via the resolved balance tool. */
export async function readBalance(session: WebMcpSession, capability: FastLaneCapability): Promise<BalanceReading> {
  const result = await session.callTool(capability.balanceTool.name, {});
  if (result.isError) {
    throw new PurchaseFailedError(`Balance check failed: ${result.text ?? "unknown error"}`, "BALANCE_READ_FAILED");
  }
  const content = result.structuredContent ?? {};
  // Only fields that mean "balance". A generic `amount` could be money, not units.
  const balance = asNumber(content["balance"] ?? content["credits"]);
  if (balance === undefined) {
    throw new PurchaseFailedError("Balance tool returned no recognizable balance field.", "BALANCE_READ_FAILED");
  }
  return {
    balance,
    accountId: asString(content["accountId"] ?? content["account_id"] ?? content["account"]),
    resource: asString(content["resource"]),
  };
}

/**
 * Call the purchase tool:
 *   { product_id, quantity, idempotency_key: purchase:{taskId}:{requirementHash} }
 *
 * Throws `PurchaseFailedError` only when the vendor EXPLICITLY reports an error
 * (nothing charged). Any other exception — timeout, dropped connection — means
 * the result is unknown, and the caller must verify by observation, never retry.
 */
export async function executePurchase(
  session: WebMcpSession,
  capability: FastLaneCapability,
  mandate: PurchaseMandate,
  idempotencyKey: string,
): Promise<PurchaseOutcome> {
  const result = await session.callTool(capability.purchaseTool.name, {
    product_id: mandate.productId,
    quantity: mandate.quantity,
    idempotency_key: idempotencyKey,
  });
  if (result.isError) {
    throw new PurchaseFailedError(`Purchase tool reported an error: ${result.text ?? "unknown error"}`);
  }
  const content = result.structuredContent ?? {};
  return {
    transactionId: asString(content["transactionId"] ?? content["transaction_id"] ?? content["id"]),
    raw: result.structuredContent,
  };
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
