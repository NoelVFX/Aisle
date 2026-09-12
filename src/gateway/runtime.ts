/**
 * One Aisle runtime, shared by both MCP transports (stdio and HTTP) and the web
 * product: config, recovery coordinator, both purchase lanes, the approval
 * server, the browsing session, and the MCP tool registrations.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createGateway, type Gateway, type Progress } from "./gateway.js";
import { loadUpstreams, type Upstreams } from "./upstreams.js";
import { startApprovalServer, type ApprovalServer } from "./approval-server.js";
import { createSteelRunner } from "./steel-runner.js";
import { createSteelPurchaser } from "./steel-purchaser.js";
import { createFastPurchaser } from "./fast-purchaser.js";
import { InMemoryIdempotencyStore } from "../fast-lane/idempotency.js";
import type { SteelProviderOptions } from "../slow-lane/steel-provider.js";
import { FileEnrollmentStore } from "../web/enrollments.js";
import { BrowsingManager } from "../web/browsing.js";
import { BROWSE_PAGE } from "../web/browse-page.js";

export interface AisleRuntime {
  root: string;
  stateDir: string;
  upstreams: Upstreams;
  gateway: Gateway;
  approval: ApprovalServer;
  browsing: BrowsingManager;
  enrollments: FileEnrollmentStore;
  log: (line: string) => void;
  close(): Promise<void>;
}

const USER_ID = "local-user";

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function startAisleRuntime(): Promise<AisleRuntime> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const envFile = join(root, ".env");
  // Node ≥ 20.12 API; the repo doesn't ship @types/node. Existing env wins over .env.
  if (existsSync(envFile)) (process as unknown as { loadEnvFile(path: string): void }).loadEnvFile(envFile);

  const stateDir = join(root, ".aisle");
  mkdirSync(stateDir, { recursive: true });
  const eventsFile = join(stateDir, "events.jsonl");
  const log = (line: string) => {
    console.error(line);
    appendFileSync(eventsFile, JSON.stringify({ at: new Date().toISOString(), log: line }) + "\n");
  };

  // `npm run mock:vendor` records the mock website's URLs. Operator config, read once.
  const mockFile = join(stateDir, "mock-vendor.json");
  if (existsSync(mockFile)) {
    try {
      const m = JSON.parse(readFileSync(mockFile, "utf8")) as { localUrl?: string; publicUrl?: string };
      if (m.localUrl && !process.env["MOCK_VENDOR_URL"]) process.env["MOCK_VENDOR_URL"] = m.localUrl;
      if (m.publicUrl && !process.env["MOCK_VENDOR_PUBLIC_URL"]) process.env["MOCK_VENDOR_PUBLIC_URL"] = m.publicUrl;
    } catch {
      log("[aisle] could not read .aisle/mock-vendor.json; using the in-process mock vendor");
    }
  }

  const steelOptions = {
    useProxy: process.env["AISLE_STEEL_PROXY_CAPTCHA"] === "1",
    solveCaptcha: process.env["AISLE_STEEL_PROXY_CAPTCHA"] === "1",
  };
  const steelProvider: SteelProviderOptions = {
    ...(process.env["AISLE_STEEL_PROXY_CAPTCHA"] === "1" ? {} : { useProxy: false, solveCaptcha: false }),
    sessionOptions: { debugConfig: { interactive: process.env["AISLE_STEEL_INTERACTIVE"] === "1", systemCursor: true } },
  };
  const realPurchaseProviders = new Set(
    (process.env["AISLE_REAL_PURCHASE_PROVIDERS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  const openInBrowser = (url: string) => {
    if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  };

  const upstreams = loadUpstreams();
  const store = new InMemoryIdempotencyStore(); // one "did we buy?" answer for both lanes
  let publicUrl = "http://127.0.0.1:8787";

  const gateway = createGateway({
    upstreams,
    publicUrl: () => publicUrl,
    steel: createSteelRunner({
      holdMs: Number(process.env["AISLE_STEEL_HOLD_MS"] ?? 120_000),
      screenshotsDir: join(stateDir, "screenshots"),
      provider: steelProvider,
    }),
    ...(process.env["STEEL_API_KEY"] ? { purchaser: createSteelPurchaser({ stateDir, steelProvider, store }) } : {}),
    fastPurchaser: createFastPurchaser({ store }),
    realPurchaseProviders,
    log,
    onEvent: (job, event) => {
      appendFileSync(eventsFile, JSON.stringify({ task: job.taskId, recovery: job.id, ...event }) + "\n");
      console.error(`[aisle] ${event.type} ${JSON.stringify(event.detail)}`);
    },
    onApprovalRequested: (job) => {
      log(`[aisle] APPROVE AT ${job.approveUrl}`);
      // Web recoveries show the card inside Aisle's browse page instead.
      if (job.surface === "cli" && process.env["AISLE_OPEN_APPROVAL"] !== "0") openInBrowser(job.approveUrl);
    },
    onSteelLive: (job) => {
      const url = job.live?.debugUrl ?? job.live?.viewerUrl;
      log(`[aisle] STEEL BROWSER LIVE ${url ?? "(no viewer url)"}`);
      if (url && job.surface === "cli" && process.env["AISLE_OPEN_VIEWER"] !== "0") openInBrowser(url);
    },
  });

  const enrollments = new FileEnrollmentStore(join(stateDir, "enrollments.json"), upstreams);
  const browsing = new BrowsingManager({
    coordinator: gateway.coordinator,
    enrollments,
    userId: USER_ID,
    steelApiKey: process.env["STEEL_API_KEY"],
    steelOptions,
    log,
  });

  const webRoutes = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const send = (status: number, body?: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
    };
    const p = url.pathname;
    if (req.method === "GET" && (p === "/" || p === "/browse")) return send(200, BROWSE_PAGE, "text/html; charset=utf-8"), true;
    if (req.method === "GET" && p === "/api/browse/state") return send(200, browsing.state()), true;
    if (req.method === "POST" && p === "/api/browse/start") {
      const body = await readJson(req);
      try {
        return send(200, await browsing.start(typeof body["url"] === "string" ? body["url"] : undefined)), true;
      } catch (err) {
        return send(400, { error: err instanceof Error ? err.message : String(err) }), true;
      }
    }
    if (req.method === "POST" && p === "/api/browse/navigate") {
      const body = await readJson(req);
      await browsing.navigate(String(body["url"] ?? ""));
      return send(204), true;
    }
    if (req.method === "POST" && p === "/api/browse/click") {
      // Local automation hook (tests, demos): click a control in the browsing session.
      const body = await readJson(req);
      await browsing.clickByRole(String(body["role"] ?? "button"), String(body["name"] ?? ""));
      return send(204), true;
    }
    if (req.method === "POST" && p === "/api/browse/stop") return await browsing.stop(), send(204), true;
    const dismiss = p.match(/^\/api\/browse\/toasts\/([^/]+)\/dismiss$/);
    if (req.method === "POST" && dismiss?.[1]) return browsing.dismissToast(dismiss[1]), send(204), true;
    if (req.method === "GET" && p === "/api/enrollments") {
      return send(200, {
        vendors: Object.entries(upstreams).map(([provider, up]) => ({ provider, billingOrigin: up.billingOrigin })),
        enrolled: enrollments.list(USER_ID).map((e) => e.provider),
      }), true;
    }
    if (req.method === "POST" && p === "/api/enrollments") {
      const body = await readJson(req);
      return send(200, enrollments.enroll(USER_ID, String(body["provider"] ?? ""))), true;
    }
    const unenroll = p.match(/^\/api\/enrollments\/([^/]+)$/);
    if (req.method === "DELETE" && unenroll?.[1]) return enrollments.unenroll(USER_ID, unenroll[1]), send(204), true;
    return false;
  };

  const approval = await startApprovalServer(gateway.coordinator, Number(process.env["AISLE_APPROVAL_PORT"] ?? 8787), 10, webRoutes);
  publicUrl = approval.url;

  const lanes = Object.entries(upstreams)
    .map(([ns, up]) => {
      if (!up.purchase) return `${ns}=viewing`;
      const fast = up.purchase.mcpUrl ? "fast→" : "";
      const submit = up.purchase.realMoney && !realPurchaseProviders.has(ns) ? "(submit withheld)" : "";
      return `${ns}=${fast}slow${submit}`;
    })
    .join(" ");
  log(`[aisle] runtime up: ${gateway.tools.map((t) => t.name).join(", ")} · approvals + browser at ${publicUrl} · lanes ${lanes}`);

  return {
    root,
    stateDir,
    upstreams,
    gateway,
    approval,
    browsing,
    enrollments,
    log,
    close: async () => {
      await browsing.stop().catch(() => {});
      await approval.close().catch(() => {});
    },
  };
}

type Extra = {
  sessionId?: string;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
};

function progressFor(extra: Extra, log: (line: string) => void): Progress {
  const token = extra._meta?.progressToken;
  let n = 0;
  return async (message) => {
    log(`[aisle] progress: ${message}`);
    if (token === undefined) return;
    await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } }).catch(() => {});
  };
}

/** Register Aisle's namespaced vendor tools plus its own tools on an MCP server. */
export function registerAisleTools(
  server: McpServer,
  runtime: Pick<AisleRuntime, "gateway" | "log">,
  taskFor: (extra: { sessionId?: string }) => string,
): void {
  const { gateway, log } = runtime;
  for (const tool of gateway.tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputShape }, async (args, extra) =>
      gateway.callTool(tool.name, args as Record<string, unknown>, {
        taskId: taskFor(extra as unknown as Extra),
        progress: progressFor(extra as unknown as Extra, log),
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
    async ({ recovery_id }, extra) => gateway.waitForRecovery(recovery_id, progressFor(extra as unknown as Extra, log)),
  );

  server.registerTool(
    "aisle__spend_report",
    { description: "Report what Aisle has spent and every recovery opened in this session." },
    async (extra) => gateway.spendReport(taskFor(extra as unknown as Extra)),
  );
}
