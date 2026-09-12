/**
 * Purchase execution via the vendor's WebMCP purchase tool.
 *
 * Critical rule: the arguments we send are derived ONLY from the mandate and
 * quote — never from tool output, page content, or anything the vendor said.
 */

import type { PurchaseMandate, Quote } from "../types.js";
import type { WebMcpSession } from "../webmcp/session.js";
import type { FastLaneCapability } from "../webmcp/detector.js";
import { PurchaseFailedError } from "../errors.js";

export interface BalanceReading {
  balance: number;
  accountId: string;
  resource: string;
}

export interface PurchaseOutcome {
  transactionId: string;
  raw: Record<string, unknown> | undefined;
}

/** Read the vendor's current balance via the resolved balance tool. */
export async function readBalance(
  session: WebMcpSession,
  capability: FastLaneCapability,
): Promise<BalanceReading> {
  const result = await session.callTool(capability.balanceTool.name, {});
  if (result.isError) {
    throw new PurchaseFailedError(`Balance check failed: ${result.text ?? "unknown error"}`);
  }
  const content = result.structuredContent ?? {};
  const balance = asNumber(content["balance"] ?? content["credits"] ?? content["amount"]);
  if (balance === undefined) {
    throw new PurchaseFailedError("Balance tool returned no recognizable balance field.");
  }
  return {
    balance,
    accountId: asString(content["accountId"] ?? content["account"]) ?? "unknown",
    resource: asString(content["resource"]) ?? "credits",
  };
}

/**
 * Call the purchase tool. Arguments come strictly from the quote/mandate.
 */
export async function executePurchase(
  session: WebMcpSession,
  capability: FastLaneCapability,
  quote: Quote,
  mandate: PurchaseMandate,
): Promise<PurchaseOutcome> {
  const args: Record<string, unknown> = {
    productId: quote.purchase.productId,
    quantity: quote.purchase.quantity,
    credits: quote.purchase.credits,
    amount: quote.purchase.price,
    currency: quote.purchase.currency,
    // Pass the mandate nonce so a well-behaved vendor can dedupe on its side too.
    idempotencyKey: mandate.nonce,
  };

  const result = await session.callTool(capability.purchaseTool.name, args);
  if (result.isError) {
    throw new PurchaseFailedError(`Purchase tool reported an error: ${result.text ?? "unknown error"}`);
  }

  const content = result.structuredContent ?? {};
  const transactionId =
    asString(content["transactionId"] ?? content["transaction_id"] ?? content["id"]) ??
    `txn_${mandate.nonce}`;

  return { transactionId, raw: result.structuredContent };
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
