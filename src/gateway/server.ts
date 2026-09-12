/**
 * Aisle MCP gateway — stdio transport, for Codex / Claude Code on this machine.
 *
 *   codex mcp add aisle -- <repo>/node_modules/.bin/tsx <repo>/src/gateway/server.ts
 *
 * The agent points at Aisle only. Aisle re-exports each upstream's tools as
 * `{namespace}__{tool}` and adds `aisle__wait_for_recovery` + `aisle__spend_report`.
 *
 * stdout is the MCP channel, so every log line goes to stderr and to
 * `.aisle/events.jsonl`. Secrets load from the repo's `.env`, never from agent config.
 *
 * The docs call for a remote HTTP gateway (§5.1) so state survives across
 * processes. Stdio keeps one gateway per agent session, which is enough to test locally.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createGateway, type Progress } from "./gateway.js";
import { loadUpstreams } from "./upstreams.js";
import { startApprovalServer } from "./approval-server.js";
import { createSteelRunner } from "./steel-runner.js";

// stdout belongs to the MCP protocol.
console.log = console.error;
console.info = console.error;

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENV_FILE = join(ROOT, ".env");
// Node ≥ 20.12 API; the repo doesn't ship @types/node, so type it locally.
// Existing environment variables win over .env values.
if (existsSync(ENV_FILE)) (process as unknown as { loadEnvFile(path: string): void }).loadEnvFile(ENV_FILE);

const STATE_DIR = join(ROOT, ".aisle");
mkdirSync(STATE_DIR, { recursive: true });
const EVENTS_FILE = join(STATE_DIR, "events.jsonl");
const log = (line: string) => {
  console.error(line);
  appendFileSync(EVENTS_FILE, JSON.stringify({ at: new Date().toISOString(), log: line }) + "\n");
};

/** CLI agents don't give a task id. One gateway process = one agent session (§5.3). */
const PROCESS_TASK = `task_${randomUUID()}`;

let publicUrl = "http://127.0.0.1:8787";
const upstreams = loadUpstreams();
const gateway = createGateway({
  upstreams,
  publicUrl: () => publicUrl,
  steel: createSteelRunner({
    holdMs: Number(process.env["AISLE_STEEL_HOLD_MS"] ?? 120_000),
    screenshotsDir: join(STATE_DIR, "screenshots"),
    // This session never checks out, so it skips Steel proxies and captcha solving
    // by default (they need a paid Steel balance). AISLE_STEEL_PROXY_CAPTCHA=1 turns
    // on the full purchase-worker config from steel.md §4.1.
    // The viewer is read-only by default (steel.md §16.2). AISLE_STEEL_INTERACTIVE=1
    // lets you click and type in the Steel browser, e.g. to log in to the vendor.
    provider: {
      ...(process.env["AISLE_STEEL_PROXY_CAPTCHA"] === "1" ? {} : { useProxy: false, solveCaptcha: false }),
      sessionOptions: { debugConfig: { interactive: process.env["AISLE_STEEL_INTERACTIVE"] === "1" } },
    },
  }),
  log,
  onEvent: (job, event) => {
    appendFileSync(EVENTS_FILE, JSON.stringify({ task: job.taskId, recovery: job.id, ...event }) + "\n");
    console.error(`[aisle] ${event.type} ${JSON.stringify(event.detail)}`);
  },
  onApprovalRequested: (job) => {
    log(`[aisle] APPROVE AT ${job.approveUrl}`);
    if (process.platform === "darwin" && process.env["AISLE_OPEN_APPROVAL"] !== "0") {
      spawn("open", [job.approveUrl], { stdio: "ignore", detached: true }).unref();
    }
  },
  onSteelLive: (job) => {
    const url = job.live?.debugUrl ?? job.live?.viewerUrl;
    log(`[aisle] STEEL BROWSER LIVE ${url ?? "(no viewer url)"}`);
    if (url && process.platform === "darwin" && process.env["AISLE_OPEN_VIEWER"] !== "0") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    }
  },
});

const approval = await startApprovalServer(gateway.coordinator, Number(process.env["AISLE_APPROVAL_PORT"] ?? 8787));
publicUrl = approval.url;
log(`[aisle] gateway up: ${gateway.tools.map((t) => t.name).join(", ")} · approvals at ${publicUrl}`);

const server = new McpServer({ name: "aisle", version: "0.1.0" });

type Extra = {
  sessionId?: string;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
};

function progressFor(extra: Extra): Progress {
  const token = extra._meta?.progressToken;
  let n = 0;
  return async (message) => {
    log(`[aisle] progress: ${message}`);
    if (token === undefined) return;
    await extra
      .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } })
      .catch(() => {});
  };
}

const taskFor = (extra: Extra) => (extra.sessionId ? `task_${extra.sessionId}` : PROCESS_TASK);

for (const tool of gateway.tools) {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputShape }, async (args, extra) =>
    gateway.callTool(tool.name, args as Record<string, unknown>, {
      taskId: taskFor(extra as unknown as Extra),
      progress: progressFor(extra as unknown as Extra),
    }),
  );
}

server.registerTool(
  "aisle__wait_for_recovery",
  {
    description:
      "Wait for an Aisle recovery (a blocked tool call awaiting purchase approval) to finish. Call this with the recovery_id from an AWAITING_APPROVAL result. Do not re-run the original tool.",
    inputSchema: { recovery_id: z.string() },
  },
  async ({ recovery_id }, extra) => gateway.waitForRecovery(recovery_id, progressFor(extra as unknown as Extra)),
);

server.registerTool(
  "aisle__spend_report",
  { description: "Report what Aisle has spent and every recovery opened in this session." },
  async (extra) => gateway.spendReport(taskFor(extra as unknown as Extra)),
);

await server.connect(new StdioServerTransport());

const shutdown = async () => {
  await approval.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
