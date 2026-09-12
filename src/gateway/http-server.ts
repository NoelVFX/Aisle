/**
 * Aisle MCP gateway — Streamable HTTP (aisle-pipeline.md §5.1).
 *
 *   npm run gateway:http
 *   codex mcp add aisle --url http://127.0.0.1:8788/mcp
 *   claude mcp add --transport http aisle http://127.0.0.1:8788/mcp
 *
 * One long-lived process: every connected agent and the web product share the
 * same recovery state. Each MCP session is its own task (task_{mcpSessionId},
 * §5.3). Set AISLE_KEY to require `Authorization: Bearer $AISLE_KEY`.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerAisleTools, startAisleRuntime, type AisleRuntime } from "./runtime.js";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : undefined;
}

export interface HttpGateway {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export function startHttpGateway(
  runtime: Pick<AisleRuntime, "gateway" | "log">,
  opts: { port?: number; host?: string; key?: string } = {},
): Promise<HttpGateway> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/health") return json(200, { ok: true, sessions: transports.size });
    if (url.pathname !== "/mcp") return json(404, { error: "not found" });
    if (opts.key && req.headers.authorization !== `Bearer ${opts.key}`) return json(401, { error: "unauthorized" });

    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (req.method !== "POST" || !isInitializeRequest(body)) {
          return json(400, { jsonrpc: "2.0", error: { code: -32000, message: "No valid MCP session. Initialize first." }, id: null });
        }
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, created);
            runtime.log(`[aisle] MCP session ${id} connected`);
          },
        });
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId);
        };
        const mcp = new McpServer({ name: "aisle", version: "0.1.0" });
        registerAisleTools(mcp, runtime, (extra) => `task_${extra.sessionId ?? randomUUID()}`);
        await mcp.connect(created);
        transport = created;
      }

      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) json(500, { jsonrpc: "2.0", error: { code: -32603, message: err instanceof Error ? err.message : String(err) }, id: null });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8788, opts.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port ?? 8788;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        server,
        close: async () => {
          for (const t of transports.values()) await t.close().catch(() => {});
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const runtime = await startAisleRuntime();
  const gateway = await startHttpGateway(runtime, {
    port: Number(process.env["AISLE_MCP_PORT"] ?? 8788),
    ...(process.env["AISLE_KEY"] ? { key: process.env["AISLE_KEY"] } : {}),
  });
  runtime.log(`[aisle] MCP gateway listening at ${gateway.url}`);
  const shutdown = async () => {
    await gateway.close();
    await runtime.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
