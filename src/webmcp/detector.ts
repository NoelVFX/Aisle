/**
 * WebMCP detection + capability resolution.
 *
 * Step 1 of the fast lane: "Does this vendor expose WebMCP purchase tools?"
 * If we can resolve a purchase tool (and a balance tool for verification), the
 * fast lane is viable; otherwise the host should fall back to the slow lane
 * (Steel + Playwright), which is owned elsewhere.
 */

import type { WebMcpSession, WebMcpTool } from "./session.js";

export interface FastLaneCapability {
  provider: string;
  /** Tool that performs the purchase / top-up. */
  purchaseTool: WebMcpTool;
  /** Tool that reads the current balance, used to verify the purchase landed. */
  balanceTool: WebMcpTool;
}

/** Capability hints a vendor may advertise via tool annotations. */
const PURCHASE_CAPABILITY = "payment.purchase";
const BALANCE_CAPABILITY = "payment.balance";

/** Name heuristics, used only when annotations are absent. Anchored: `get_purchase_history` is not a purchase. */
const PURCHASE_NAME_PATTERNS = [
  /^purchase[_-]?credits?$/i,
  /^buy[_-]?credits?$/i,
  /^top[_-]?up([_-]?credits?)?$/i,
  /^add[_-]?credits?$/i,
];

const BALANCE_NAME_PATTERNS = [
  /get[_-]?(credit[_-]?)?balance/i,
  /credit[_-]?balance/i,
  /^balance$/i,
];

function matchByCapability(tools: WebMcpTool[], capability: string): WebMcpTool | undefined {
  return tools.find((t) => t.annotations?.capability === capability);
}

function matchByName(tools: WebMcpTool[], patterns: RegExp[]): WebMcpTool | undefined {
  return tools.find((t) => patterns.some((p) => p.test(t.name)));
}

function resolvePurchaseTool(tools: WebMcpTool[]): WebMcpTool | undefined {
  // A tool the vendor marks read-only is never used to spend money.
  const candidates = tools.filter((t) => t.annotations?.readOnlyHint !== true);
  return matchByCapability(candidates, PURCHASE_CAPABILITY) ?? matchByName(candidates, PURCHASE_NAME_PATTERNS);
}

function resolveBalanceTool(tools: WebMcpTool[]): WebMcpTool | undefined {
  return matchByCapability(tools, BALANCE_CAPABILITY) ?? matchByName(tools, BALANCE_NAME_PATTERNS);
}

export interface DetectionResult {
  viable: boolean;
  capability?: FastLaneCapability;
  /** Human-readable reason the fast lane is or isn't available. */
  reason: string;
  discoveredTools: string[];
}

/**
 * Inspect a live WebMCP session and decide whether the fast lane can run.
 */
export async function detectWebMcp(session: WebMcpSession): Promise<DetectionResult> {
  const tools = await session.listTools();
  const discoveredTools = tools.map((t) => t.name);

  const purchaseTool = resolvePurchaseTool(tools);
  const balanceTool = resolveBalanceTool(tools);

  if (!purchaseTool) {
    return {
      viable: false,
      reason: "No WebMCP purchase tool advertised by vendor; use slow lane.",
      discoveredTools,
    };
  }

  if (!balanceTool) {
    return {
      viable: false,
      reason: "Purchase tool found but no balance tool to verify entitlement; use slow lane.",
      discoveredTools,
    };
  }

  return {
    viable: true,
    capability: { provider: session.provider, purchaseTool, balanceTool },
    reason: `Fast lane viable via '${purchaseTool.name}' + '${balanceTool.name}'.`,
    discoveredTools,
  };
}
