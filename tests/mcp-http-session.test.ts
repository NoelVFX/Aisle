/**
 * Proves `McpWebMcpSession` is correct against the REAL MCP protocol — JSON-RPC
 * framing, Zod validation, tools/list + tools/call — not just our hand-written
 * mock. It uses `InMemoryTransport.createLinkedPair()` (the SDK's own pattern
 * for in-process client/server tests) so there is no network involved, but
 * every message still goes through actual MCP (de)serialization.
 */
import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpWebMcpSession } from "../src/webmcp/mcp-http-session.js";
import { detectWebMcp } from "../src/webmcp/detector.js";
import { runFastLane } from "../src/fast-lane/executor.js";
import { MandateRejectedError, NoFastLaneError } from "../src/errors.js";
import { makeRequest as buildRequest, SECRET as TEST_SECRET } from "./fixtures.js";

const PROVIDER = "real-vendor";
const ORIGIN = "https://api.real-vendor.test";

/** A real MCP server exposing the two WebMCP tools a fast-lane vendor needs. */
function startRealVendorServer(opts: { balance?: number } = {}) {
  const server = new McpServer({ name: "real-vendor", version: "1.0.0" });
  let balance = opts.balance ?? 0;
  let purchaseCallCount = 0;

  server.registerTool(
    "get_credit_balance",
    {
      description: "Return the account's current credit balance.",
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ balance }) }],
      structuredContent: { balance, accountId: "acct_real_1", resource: "credits" },
    }),
  );

  server.registerTool(
    "purchase_credits",
    {
      description: "Buy a credit package for the account.",
      inputSchema: {
        product_id: z.literal("credits_5000"),
        quantity: z.number(),
        idempotency_key: z.string(),
      },
    },
    async (args) => {
      purchaseCallCount += 1;
      balance += 5000 * args.quantity;
      return {
        content: [{ type: "text" as const, text: "purchased" }],
        structuredContent: {
          transactionId: `txn_real_${purchaseCallCount}`,
          creditsAdded: 5000 * args.quantity,
          balance,
        },
      };
    },
  );

  return { server, getPurchaseCallCount: () => purchaseCallCount };
}

async function connectSessionTo(server: McpServer): Promise<McpWebMcpSession> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const session = new McpWebMcpSession({ provider: PROVIDER, url: ORIGIN, transport: clientTransport });
  await session.connect();
  return session;
}

function makeRequest() {
  return buildRequest({ provider: PROVIDER, origin: ORIGIN });
}

describe("McpWebMcpSession — real MCP protocol round trip", () => {
  let session: McpWebMcpSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  it("discovers real tools via tools/list", async () => {
    const { server } = startRealVendorServer();
    session = await connectSessionTo(server);

    const detection = await detectWebMcp(session);

    expect(detection.viable).toBe(true);
    expect(detection.discoveredTools).toEqual(
      expect.arrayContaining(["get_credit_balance", "purchase_credits"]),
    );
  });

  it("runs the full fast lane against a real server (purchase + verify + resume)", async () => {
    const { server, getPurchaseCallCount } = startRealVendorServer({ balance: 0 });
    session = await connectSessionTo(server);

    const result = await runFastLane(makeRequest(), { session, mandateSecret: TEST_SECRET });

    expect(getPurchaseCallCount()).toBe(1);
    expect(result.verifiedEntitlement.balance).toBe(5000);
    expect(result.resumeToken.resumeAction).toEqual({
      tool: "generate_image",
      arguments: { prompt: "hero #2" },
    });
  });

  it("still enforces origin lock when the transport is real", async () => {
    const { server } = startRealVendorServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    // Session origin does not match the mandate's authorized origin.
    session = new McpWebMcpSession({
      provider: PROVIDER,
      url: "https://evil-site.test",
      transport: clientTransport,
    });
    await session.connect();

    await expect(runFastLane(makeRequest(), { session, mandateSecret: TEST_SECRET })).rejects.toBeInstanceOf(MandateRejectedError);
  });

  it("reports NoFastLaneError when the real server has no purchase tool", async () => {
    const server = new McpServer({ name: "no-purchase-vendor", version: "1.0.0" });
    server.registerTool(
      "get_credit_balance",
      { description: "balance only" },
      async () => ({ content: [{ type: "text" as const, text: "{}" }], structuredContent: { balance: 0 } }),
    );
    session = await connectSessionTo(server);

    await expect(runFastLane(makeRequest(), { session, mandateSecret: TEST_SECRET })).rejects.toBeInstanceOf(NoFastLaneError);
  });
});
