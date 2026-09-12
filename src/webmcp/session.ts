/**
 * WebMCP transport abstraction.
 *
 * "WebMCP" = a vendor website/endpoint that exposes MCP tools the agent can
 * call directly (e.g. `purchase_credits`, `get_credit_balance`) instead of
 * clicking through a checkout page. Because the top-up-agent runs inside a host
 * coding agent, the HOST is responsible for actually connecting to the vendor's
 * WebMCP endpoint and handing us a live `WebMcpSession`. We never open sockets
 * ourselves — we only drive the tools through this interface.
 *
 * This keeps the fast lane testable: the mock vendor implements the same
 * interface a real host connection would.
 */

export interface WebMcpToolAnnotations {
  /**
   * Optional capability hint a well-behaved WebMCP vendor can advertise, e.g.
   * "payment.purchase" or "payment.balance". When present it is preferred over
   * name heuristics. Never trusted to authorize an origin.
   */
  capability?: string;
  /** Whether calling the tool has side effects (a purchase does). */
  readOnlyHint?: boolean;
  title?: string;
}

export interface WebMcpTool {
  name: string;
  description?: string;
  /** JSON Schema of the tool's input, as published by the vendor. */
  inputSchema?: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
}

export interface WebMcpToolResult {
  /** Tool-level error flag per MCP semantics. */
  isError: boolean;
  /** Structured result payload (balances, transaction ids, etc.). */
  structuredContent?: Record<string, unknown>;
  /** Free-text content, if the tool returned only text. */
  text?: string;
}

/**
 * A live connection to ONE vendor's WebMCP surface, supplied by the host agent.
 */
export interface WebMcpSession {
  /**
   * The origin this session is actually connected to. Used for the origin-lock
   * check — it must match the mandate's task-configured origin.
   */
  readonly origin: string;
  readonly provider: string;

  /** Enumerate the tools the vendor advertises. */
  listTools(): Promise<WebMcpTool[]>;

  /** Invoke a vendor tool by name. */
  callTool(name: string, args: Record<string, unknown>): Promise<WebMcpToolResult>;
}
