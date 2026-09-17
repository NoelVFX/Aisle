/**
 * In-memory mock of a vendor that exposes purchase tools (fast lane). Stands in
 * for a real gateway-supplied `WebMcpSession` so the fast lane runs end-to-end
 * with no network and no money.
 *
 * Like the scaffold's mock vendor, `purchase_credits` looks the product up in
 * its OWN catalogue — the client never tells the vendor how many credits to add.
 */

import type { WebMcpSession, WebMcpTool, WebMcpToolResult } from "../../src/webmcp/session.js";

export interface FakeCatalogueItem {
  productId: string;
  units: number;
  price: number;
}

export interface FakeWebMcpVendorOptions {
  provider?: string;
  origin?: string;
  startingBalance?: number;
  accountId?: string;
  catalogue?: FakeCatalogueItem[];
  /** Expose no purchase tool, to exercise the slow-lane fallback. */
  withoutPurchaseTool?: boolean;
  /** Complete checkout but do NOT credit the account (verification must fail). */
  simulateBalanceNotUpdated?: boolean;
  /** Charge the account, then throw as if the response was lost in transit. */
  loseResponseAfterCharge?: boolean;
  /** Alias from the standalone fast-lane mock. */
  simulateLostResponseOnPurchase?: boolean;
  /** Number of post-purchase reads that still report the old balance. */
  balanceVisibilityDelayReads?: number;
}

export const FAKE_CATALOGUE: FakeCatalogueItem[] = [
  { productId: "credits_1000", units: 1000, price: 5 },
  { productId: "credits_5000", units: 5000, price: 20 },
  { productId: "credits_20000", units: 20000, price: 70 },
];

export class FakeWebMcpVendor implements WebMcpSession {
  readonly provider: string;
  readonly origin: string;
  balance: number;
  private staleBalance: number | undefined;
  private staleReadsRemaining = 0;
  private readonly accountId: string;
  private readonly opts: FakeWebMcpVendorOptions;
  private readonly catalogue: FakeCatalogueItem[];
  private readonly seenKeys = new Map<string, string>();
  purchaseCallCount = 0;
  chargeCount = 0;

  constructor(opts: FakeWebMcpVendorOptions = {}) {
    this.provider = opts.provider ?? "mock-image-api";
    this.origin = opts.origin ?? "https://api.mock-image-api.test";
    this.balance = opts.startingBalance ?? 0;
    this.accountId = opts.accountId ?? "acct_mock_001";
    this.catalogue = opts.catalogue ?? FAKE_CATALOGUE;
    this.opts = opts;
  }

  async listTools(): Promise<WebMcpTool[]> {
    const tools: WebMcpTool[] = [
      {
        name: "get_credit_balance",
        description: "Return the account's current credit balance.",
        annotations: { capability: "payment.balance", readOnlyHint: true },
      },
    ];
    if (!this.opts.withoutPurchaseTool) {
      tools.push({
        name: "purchase_credits",
        description: "Buy a credit package for the account.",
        annotations: { capability: "payment.purchase", readOnlyHint: false },
      });
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<WebMcpToolResult> {
    if (name === "get_credit_balance") {
      let reported = this.balance;
      if (this.staleReadsRemaining > 0) {
        reported = this.staleBalance ?? this.balance;
        this.staleReadsRemaining -= 1;
      }
      return {
        isError: false,
        structuredContent: { balance: reported, accountId: this.accountId, resource: "credits" },
      };
    }

    if (name === "purchase_credits") {
      this.purchaseCallCount += 1;
      const item = this.catalogue.find((c) => c.productId === args["product_id"]);
      if (!item) return { isError: true, text: `unknown_product: ${String(args["product_id"])}` };

      // Vendor-side dedupe on the idempotency key.
      const key = typeof args["idempotency_key"] === "string" ? args["idempotency_key"] : undefined;
      const prior = key === undefined ? undefined : this.seenKeys.get(key);
      if (prior) return { isError: false, structuredContent: { transactionId: prior, balance: this.balance } };

      const quantity = Number(args["quantity"] ?? 1);
      this.chargeCount += 1;
      const txn = `txn_mock_${this.chargeCount}`;
      if (key !== undefined) this.seenKeys.set(key, txn);
      if (!this.opts.simulateBalanceNotUpdated) {
        this.staleBalance = this.balance;
        this.staleReadsRemaining = this.opts.balanceVisibilityDelayReads ?? 0;
        this.balance += item.units * quantity;
      }
      if (this.opts.loseResponseAfterCharge || this.opts.simulateLostResponseOnPurchase) throw new Error("socket hang up");
      return {
        isError: false,
        structuredContent: { transactionId: txn, creditsAdded: item.units * quantity, balance: this.balance },
      };
    }

    return { isError: true, text: `Unknown tool: ${name}` };
  }
}
