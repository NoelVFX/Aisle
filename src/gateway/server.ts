/**
 * Aisle MCP gateway — stdio transport (one gateway per agent process).
 *
 *   codex mcp add aisle -- <repo>/node_modules/.bin/tsx <repo>/src/gateway/server.ts
 *
 * Prefer the shared HTTP gateway (`npm run gateway:http`, aisle-pipeline.md §5.1)
 * so several agents and the web product share one runtime and its state.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAisleTools, startAisleRuntime } from "./runtime.js";

// stdout belongs to the MCP protocol.
console.log = console.error;
console.info = console.error;

/** CLI agents don't give a task id. One stdio gateway process = one agent session (§5.3). */
const PROCESS_TASK = `task_${randomUUID()}`;

const runtime = await startAisleRuntime();
const server = new McpServer({ name: "aisle", version: "0.1.0" });
registerAisleTools(server, runtime, (extra) => (extra.sessionId ? `task_${extra.sessionId}` : PROCESS_TASK));
await server.connect(new StdioServerTransport());

const shutdown = async () => {
  await runtime.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
