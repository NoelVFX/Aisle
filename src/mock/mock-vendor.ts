/**
 * In-memory mock of a vendor that exposes WebMCP purchase tools. Stands in for
 * a real host-supplied `WebMcpSession` so the fast lane runs end-to-end with no
 * network and no money. Mirrors the shape of a real WebMCP surface:
 * `get_credit_balance` + `purchase_credits`.
 */

import type {
  WebMcpSession,
  WebMcpTool,
  WebMcpToolResult,
} from "../webmcp/session.js";

export interface MockVendorOptions {
  provider?: string;
  origin?: string;
  startingBalance?: number;
  accountId?: string;
  /** Expose no purchase tool, to exercise the slow-lane fallback. */
  withoutPurchaseTool?: boolean;
  /** Complete checkout but do NOT credit the account (verification must fail). */
  simulateBalanceNotUpdated?: boolean;
}

export class MockWebMcpVendor implements WebMcpSession {
  readonly provider: string;
  readonly origin: string;
  private balance: number;
  private readonly accountId: string;
  private readonly opts: MockVendorOptions;
  purchaseCallCount = 0;

  constructor(opts: MockVendorOptions = {}) {
    this.provider = opts.provider ?? "mock-image-api";
    this.origin = opts.origin ?? "https://api.mock-image-api.test";
    this.balance = opts.startingBalance ?? 0;
    this.accountId = opts.accountId ?? "acct_mock_001";
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
      return {
        isError: false,
        structuredContent: {
          balance: this.balance,
          accountId: this.accountId,
          resource: "credits",
        },
      };
    }

    if (name === "purchase_credits") {
      this.purchaseCallCount += 1;
      const credits = Number(args["credits"] ?? 0);
      if (!this.opts.simulateBalanceNotUpdated) {
        this.balance += credits;
      }
      return {
        isError: false,
        structuredContent: {
          transactionId: `txn_mock_${this.purchaseCallCount}`,
          creditsAdded: credits,
          balance: this.balance,
        },
      };
    }

    return { isError: true, text: `Unknown tool: ${name}` };
  }
}
