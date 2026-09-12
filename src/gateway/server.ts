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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createGateway, type Progress } from "./gateway.js";
import { loadUpstreams } from "./upstreams.js";
import { startApprovalServer } from "./approval-server.js";
import { createSteelRunner } from "./steel-runner.js";
import { createSteelPurchaser } from "./steel-purchaser.js";
import { steelReplaySource } from "./replay.js";
import { startTunnel, type Tunnel } from "./tunnel.js";
import { DEFAULT_LINK_TTL_MS } from "./watch-access.js";
import { MCP_APP_MIME, renderWidgetHtml, WATCH_WIDGET_URI, widgetResourceMeta } from "./watch-ui.js";
import { InMemoryIdempotencyStore } from "../fast-lane/idempotency.js";
import type { SteelProviderOptions } from "../slow-lane/steel-provider.js";

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
  // Watch URLs carry their access token. The terminal gets the clickable link; the file never gets the token.
  appendFileSync(EVENTS_FILE, JSON.stringify({ at: new Date().toISOString(), log: line.replace(/([?&]t=)[A-Za-z0-9_-]+/g, "$1…") }) + "\n");
};

// `npm run mock:vendor` records the mock website's URLs here. Operator config,
// read once at startup — never a value from a tool result.
const MOCK_FILE = join(STATE_DIR, "mock-vendor.json");
if (existsSync(MOCK_FILE)) {
  try {
    const m = JSON.parse(readFileSync(MOCK_FILE, "utf8")) as { localUrl?: string; publicUrl?: string };
    if (m.localUrl && !process.env["MOCK_VENDOR_URL"]) process.env["MOCK_VENDOR_URL"] = m.localUrl;
    if (m.publicUrl && !process.env["MOCK_VENDOR_PUBLIC_URL"]) process.env["MOCK_VENDOR_PUBLIC_URL"] = m.publicUrl;
  } catch {
    log("[aisle] could not read .aisle/mock-vendor.json; using the in-process mock vendor");
  }
}

/** CLI agents don't give a task id. One gateway process = one agent session (§5.3). */
const PROCESS_TASK = `task_${randomUUID()}`;

// Steel plan without paid balance: no proxies or captcha solving unless enabled.
// The viewer is read-only unless AISLE_STEEL_INTERACTIVE=1 (steel.md §16.2).
const viewerInteractive = process.env["AISLE_STEEL_INTERACTIVE"] === "1";
const steelProvider: SteelProviderOptions = {
  ...(process.env["AISLE_STEEL_PROXY_CAPTCHA"] === "1" ? {} : { useProxy: false, solveCaptcha: false }),
  sessionOptions: { debugConfig: { interactive: viewerInteractive } },
};
// Slow-lane sessions accept input so a 3-DS/OTP takeover can hand the browser to
// the user. The watch page still embeds them view-only, behind a shield, until a
// takeover is pending. AISLE_STEEL_TAKEOVER=0 makes them non-interactive; a
// challenge then fails the recovery.
const purchaserProvider: SteelProviderOptions = {
  ...steelProvider,
  sessionOptions: { debugConfig: { interactive: viewerInteractive || process.env["AISLE_STEEL_TAKEOVER"] !== "0" } },
};

const realPurchaseProviders = new Set(
  (process.env["AISLE_REAL_PURCHASE_PROVIDERS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

// Where watch links point: a deployed gateway or your own tunnel. Defaults to the local server.
const configuredPublicUrl = process.env["AISLE_PUBLIC_URL"]?.replace(/\/+$/, "") || undefined;
let publicUrl = configuredPublicUrl ?? "http://127.0.0.1:8787";
const upstreams = loadUpstreams();
const openInBrowser = (url: string) => {
  if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
};

const gateway = createGateway({
  upstreams,
  publicUrl: () => publicUrl,
  steel: createSteelRunner({
    holdMs: Number(process.env["AISLE_STEEL_HOLD_MS"] ?? 120_000),
    screenshotsDir: join(STATE_DIR, "screenshots"),
    provider: steelProvider,
  }),
  ...(process.env["STEEL_API_KEY"]
    ? { purchaser: createSteelPurchaser({ stateDir: STATE_DIR, steelProvider: purchaserProvider, store: new InMemoryIdempotencyStore() }) }
    : {}),
  realPurchaseProviders,
  log,
  // Terminal only: the watch URL carries its token, so it never goes to events.jsonl.
  announce: (line) => console.error(`[aisle] ${line}`),
  onEvent: (job, event) => {
    appendFileSync(EVENTS_FILE, JSON.stringify({ task: job.taskId, recovery: job.id, ...event }) + "\n");
    console.error(`[aisle] ${event.type} ${JSON.stringify(event.detail)}`);
  },
  onApprovalRequested: (job) => {
    log(`[aisle] approval requested for recovery ${job.id}`);
    if (process.env["AISLE_OPEN_APPROVAL"] !== "0") openInBrowser(job.approveUrl);
  },
  // The live browser is watched on the recovery page, never through the raw player URL.
  onSteelLive: (job) => log(`[aisle] Steel session ${job.live?.sessionId ?? "?"} is live on the recovery page`),
});

const approval = await startApprovalServer(gateway.coordinator, {
  port: Number(process.env["AISLE_APPROVAL_PORT"] ?? 8787),
  host: process.env["AISLE_APPROVAL_HOST"] ?? "127.0.0.1",
  linkTtlMs: Number(process.env["AISLE_LINK_TTL_MS"]) || DEFAULT_LINK_TTL_MS,
  viewerInteractive,
  ...(process.env["STEEL_API_KEY"] ? { replay: steelReplaySource({ apiKey: process.env["STEEL_API_KEY"] }) } : {}),
});
if (!configuredPublicUrl) publicUrl = approval.url;

// AISLE_TUNNEL=1: a Cloudflare quick tunnel, so watch links open on a phone.
let tunnel: Tunnel | undefined;
if (process.env["AISLE_TUNNEL"] === "1" && !configuredPublicUrl) {
  startTunnel(approval.url).then(
    (t) => {
      tunnel = t;
      publicUrl = t.url;
      log(`[aisle] watch links now point at ${t.url}`);
    },
    (err: unknown) => log(`[aisle] tunnel failed, watch links stay local: ${err instanceof Error ? err.message : String(err)}`),
  );
}
const lanes = Object.entries(upstreams)
  .map(([ns, up]) => `${ns}=${up.purchase ? (up.purchase.realMoney ? (realPurchaseProviders.has(ns) ? "slow-lane(real submit)" : "slow-lane(submit withheld)") : "slow-lane") : "viewing"}`)
  .join(" ");
log(`[aisle] gateway up: ${gateway.tools.map((t) => t.name).join(", ")} · approvals at ${publicUrl} · lanes ${lanes}`);

const server = new McpServer({ name: "aisle", version: "0.1.0" });

// The in-app live viewer for GUI agents (MCP Apps): same renderer, same stream as the page.
const watchUiMeta = { ui: { resourceUri: WATCH_WIDGET_URI }, "ui/resourceUri": WATCH_WIDGET_URI };
server.registerResource(
  "aisle-watch-live",
  WATCH_WIDGET_URI,
  {
    title: "Aisle · Watch live",
    description: "The live browser Aisle is driving for a recovery, its event timeline, and the approval card.",
    mimeType: MCP_APP_MIME,
  },
  async () => ({
    contents: [{ uri: WATCH_WIDGET_URI, mimeType: MCP_APP_MIME, text: renderWidgetHtml(), _meta: widgetResourceMeta(publicUrl) }],
  }),
);

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
    _meta: watchUiMeta,
  },
  async ({ recovery_id }, extra) => gateway.waitForRecovery(recovery_id, progressFor(extra as unknown as Extra)),
);

server.registerTool(
  "aisle__watch_recovery",
  {
    description:
      "Show the user the live browser Aisle is driving for a recovery, with its event timeline and approval card. Returns immediately with the watch link; GUI clients render the live viewer inline.",
    inputSchema: { recovery_id: z.string() },
    _meta: watchUiMeta,
  },
  async ({ recovery_id }) => gateway.watchRecovery(recovery_id),
);

server.registerTool(
  "aisle__spend_report",
  { description: "Report what Aisle has spent and every recovery opened in this session." },
  async (extra) => gateway.spendReport(taskFor(extra as unknown as Extra)),
);

await server.connect(new StdioServerTransport());

const shutdown = async () => {
  tunnel?.close();
  await approval.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
