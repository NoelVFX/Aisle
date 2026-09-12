/**
 * Real `WebMcpSession` backed by the official MCP TypeScript SDK.
 *
 * This is the only file in the package that opens a real connection to a
 * vendor. It has no purchase logic, no guards, no idempotency of its own —
 * all of that stays in `../fast-lane/*`, untouched. Its one job is transport:
 * turn a real `tools/list` / `tools/call` round trip (over Streamable HTTP,
 * per the current MCP spec) into the plain shape `detectWebMcp` and the
 * fast-lane executor already know how to drive.
 *
 * Origin and provider are supplied by the caller (task configuration) and
 * never inferred from the server's own responses — the fast lane's origin
 * lock depends on that being true.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CallToolResult,
  ContentBlock,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  WebMcpSession,
  WebMcpTool,
  WebMcpToolAnnotations,
  WebMcpToolResult,
} from "./session.js";

export interface McpWebMcpSessionOptions {
  /**
   * Provider id, exactly as it appears in the task's `PurchaseOrigin` /
   * mandate / quote. Authoritative — never read from the server.
   */
  provider: string;
  /**
   * The vendor endpoint URL, taken from task configuration (never from a
   * tool result or page content). Its origin becomes `session.origin`,
   * which the fast lane's origin-lock guard checks against the mandate.
   */
  url: string | URL;
  /** Extra HTTP headers sent with every request (e.g. an account-scoped bearer token). Never put card data here. */
  headers?: Record<string, string>;
  /** Identifies this client to the vendor during MCP initialize. */
  clientInfo?: { name: string; version: string };
  /**
   * Override transport construction entirely — e.g. to inject an
   * `InMemoryTransport` in tests, or to use a different MCP transport than
   * Streamable HTTP. When omitted, connects over Streamable HTTP to `url`.
   */
  transport?: Transport;
}

const DEFAULT_CLIENT_INFO = { name: "top-up-agent-fast-lane", version: "0.1.0" };

/**
 * Connects to a real vendor MCP endpoint and exposes it as a `WebMcpSession`.
 * Single-purpose: create one per recovery attempt, call `close()` when done.
 */
export class McpWebMcpSession implements WebMcpSession {
  readonly provider: string;
  readonly origin: string;

  private readonly client: Client;
  private connected = false;
  private connecting: Promise<void> | undefined;

  constructor(private readonly opts: McpWebMcpSessionOptions) {
    this.provider = opts.provider;
    this.origin = new URL(opts.url).origin;
    this.client = new Client(opts.clientInfo ?? DEFAULT_CLIENT_INFO, { capabilities: {} });
  }

  /** Establish the MCP connection. Idempotent — safe to call more than once or concurrently. */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connecting) {
      this.connecting = this.client.connect(this.opts.transport ?? this.buildTransport()).then(() => {
        this.connected = true;
      });
    }
    await this.connecting;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
    this.connecting = undefined;
  }

  async listTools(): Promise<WebMcpTool[]> {
    await this.connect();
    const { tools } = await this.client.listTools();
    return tools.map(toWebMcpTool);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<WebMcpToolResult> {
    await this.connect();
    const result = await this.client.callTool({ name, arguments: args });
    return toWebMcpToolResult(result as CallToolResult);
  }

  private buildTransport(): Transport {
    const options: StreamableHTTPClientTransportOptions = {};
    if (this.opts.headers) {
      options.requestInit = { headers: this.opts.headers };
    }
    // The SDK's own transport class has an optional `sessionId` typed without
    // `| undefined`, which trips `exactOptionalPropertyTypes` at the
    // `Transport` boundary even though it fully implements the interface.
    return new StreamableHTTPClientTransport(new URL(this.opts.url), options) as Transport;
  }
}

/** Construct-and-connect in one call. */
export async function connectMcpWebMcpSession(options: McpWebMcpSessionOptions): Promise<McpWebMcpSession> {
  const session = new McpWebMcpSession(options);
  await session.connect();
  return session;
}

// ---------------------------------------------------------------------------
// SDK <-> WebMcpSession shape translation
// ---------------------------------------------------------------------------

function toWebMcpTool(tool: McpTool): WebMcpTool {
  // A vendor-declared capability hint travels in `_meta` — the one part of
  // the MCP Tool schema the SDK does NOT strip to a fixed set of keys.
  // `annotations` on a real server is validated against a closed schema
  // (title/readOnlyHint/destructiveHint/idempotentHint/openWorldHint), so a
  // custom "capability" field there would be silently dropped in transit.
  const meta = tool._meta as Record<string, unknown> | undefined;
  const capability = asString(meta?.["capability"]);

  const annotations: WebMcpToolAnnotations = {
    ...(tool.annotations?.title !== undefined ? { title: tool.annotations.title } : {}),
    ...(tool.annotations?.readOnlyHint !== undefined ? { readOnlyHint: tool.annotations.readOnlyHint } : {}),
    ...(capability !== undefined ? { capability } : {}),
  };

  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

function toWebMcpToolResult(result: CallToolResult): WebMcpToolResult {
  const textParts = (result.content ?? []).filter(isTextBlock).map((block) => block.text);
  const text = textParts.length > 0 ? textParts.join("\n") : undefined;
  // Prefer the spec's `structuredContent`; fall back to parsing JSON a
  // less-modern vendor returned only as text content.
  const structuredContent = result.structuredContent ?? (text !== undefined ? tryParseJson(text) : undefined);

  return {
    isError: result.isError ?? false,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

function isTextBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "text" }> {
  return block.type === "text";
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
