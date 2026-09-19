/**
 * One Aisle runtime, shared by both MCP transports (stdio and HTTP) and the web
 * product: config, recovery coordinator, both purchase lanes, the approval
 * server, the browsing session, and the MCP tool registrations.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InMemoryOrderStore } from "../order-tracking/order-store.js";
import { OrderEventBus } from "../order-tracking/order-events.js";
import { OrderTracker } from "../order-tracking/order-tracker.js";
import { OrderWaiter } from "../order-tracking/order-waiter.js";
import { createGateway, type Gateway, type Progress } from "./gateway.js";
import { loadUpstreams, type Upstreams } from "./upstreams.js";
import { startApprovalServer, type ApprovalServer } from "./approval-server.js";
import { createLocalRunner } from "./runner.js";
import { createSlowLanePurchaser } from "./purchaser.js";
import { createFastPurchaser } from "./fast-purchaser.js";
import { createBalanceReaders } from "./balances.js";
import { isOpen, type RecoveryJob } from "./recovery.js";
import { InMemoryIdempotencyStore } from "../fast-lane/idempotency.js";
import { FileEnrollmentStore } from "../web/enrollments.js";
import { BrowsingManager, type BrowsingView } from "../web/browsing.js";
import { BROWSE_PAGE } from "../web/browse-page.js";
import { ExternalActionManager, LocalExternalActionExecutor } from "../web/external-action.js";
import { LoginManager } from "../web/login-manager.js";
import { loginPage } from "../web/login-page.js";
import { FileProfileStore } from "../slow-lane/profiles.js";
import { MCP_APP_MIME, RECOVERY_WIDGET_CSP, RECOVERY_WIDGET_HTML, RECOVERY_WIDGET_URI } from "./widget.js";

export interface AisleRuntime {
  root: string;
  stateDir: string;
  upstreams: Upstreams;
  gateway: Gateway;
  approval: ApprovalServer;
  browsing: BrowsingManager;
  externalActions?: ExternalActionManager;
  orderTracker: OrderTracker;
  orderWaiter: OrderWaiter;
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

  // `npm run vendor:studio` records the Stripe test-mode vendor's URLs and API key. Operator config, read once.
  const studioFile = join(stateDir, "studio.json");
  if (existsSync(studioFile)) {
    try {
      const studio = JSON.parse(readFileSync(studioFile, "utf8")) as { localUrl?: string; publicUrl?: string; apiKey?: string };
      if (studio.localUrl && !process.env["STUDIO_URL"]) process.env["STUDIO_URL"] = studio.localUrl;
      if (studio.publicUrl && !process.env["STUDIO_PUBLIC_URL"]) process.env["STUDIO_PUBLIC_URL"] = studio.publicUrl;
      if (studio.apiKey && !process.env["STUDIO_API_KEY"]) process.env["STUDIO_API_KEY"] = studio.apiKey;
    } catch {
      log("[aisle] could not read .aisle/studio.json; the Studio vendor is disabled");
    }
  }

  const realPurchaseProviders = new Set(
    (process.env["AISLE_REAL_PURCHASE_PROVIDERS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  const openInBrowser = (url: string) => {
    if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  };

  const upstreams = loadUpstreams();
  const balanceReaders = createBalanceReaders(upstreams, process.env);
  const store = new InMemoryIdempotencyStore(); // one "did we buy?" answer for both lanes
  const orderStore = new InMemoryOrderStore();
  const orderEvents = new OrderEventBus();
  const orderTracker = new OrderTracker(orderStore, orderEvents);
  const orderWaiter = new OrderWaiter(orderEvents);
  const openedViewers = new Set<string>();
  let publicUrl = "http://127.0.0.1:8787";

  const gateway = createGateway({
    upstreams,
    publicUrl: () => publicUrl,
    balanceReaders,
    // CLI recoveries are approved and watched on the browse page: card, preview screenshot, timeline.
    // One link for every CLI agent (Hermes, Claude Code, Codex): the page follows the latest recovery.
    approveUrlFor: (id, surface) => (surface === "cli" ? `${publicUrl}/browse` : `${publicUrl}/r/${id}`),
    steel: createLocalRunner({
      holdMs: Number(process.env["AISLE_STEEL_HOLD_MS"] ?? 120_000),
      screenshotsDir: join(stateDir, "screenshots"),
      previewProfilesDir: join(stateDir, "preview-profiles"),
    }),
    purchaser: createSlowLanePurchaser({ stateDir, store, balanceReaders }),
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
      // Local engine: the browser is a real window on this machine. Watch it directly.
      log(`[aisle] browser session ${job.live?.sessionId ?? "?"} live — a Chromium window opened on this machine.`);
    },
  });

  const enrollments = new FileEnrollmentStore(join(stateDir, "enrollments.json"), upstreams);
  const browsing = new BrowsingManager({
    coordinator: gateway.coordinator,
    enrollments,
    userId: USER_ID,
    profilesDir: join(stateDir, "profiles"),
    headed: true, // the user drives this window directly
    log,
  });
  const profileStore = new FileProfileStore(join(stateDir, "profiles"));
  const loginManager = new LoginManager({ profilesDir: join(stateDir, "profiles"), store: profileStore, userId: USER_ID, log });
  const externalActions = new ExternalActionManager({
    upstreams,
    coordinator: gateway.coordinator,
    executor: new LocalExternalActionExecutor({ profilesDir: join(stateDir, "profiles"), headed: process.env["AISLE_HEADED"] === "1" }),
    profilesDir: join(stateDir, "profiles"),
    store: profileStore,
    loginManager,
    publicUrl: () => publicUrl,
  });

  const webRoutes = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const send = (status: number, body?: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
    };
    const p = url.pathname;
    if (req.method === "GET" && (p === "/" || p === "/browse")) return send(200, BROWSE_PAGE, "text/html; charset=utf-8"), true;
    if (req.method === "GET" && p === "/api/browse/state") {
      const view: BrowsingView & { recoveryNote?: string } = browsing.state();
      const pinned = url.searchParams.get("recovery");
      const job = view.recoveryId ? undefined : pinned ? gateway.coordinator.get(pinned) : latestCliRecovery(gateway.coordinator.list());
      if (job) Object.assign(view, cliRecoveryView(job));
      return send(200, view), true;
    }
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
    if (req.method === "POST" && p === "/api/actions") {
      const body = await readJson(req);
      try {
        const prompt = typeof body["prompt"] === "string" ? body["prompt"] : "";
        return send(200, await externalActions.execute({
          taskId: typeof body["task_id"] === "string" ? body["task_id"] : `web_${randomUUID()}`,
          prompt,
          ...(typeof body["url"] === "string" ? { url: body["url"] } : {}),
          ...(typeof body["max_steps"] === "number" ? { maxSteps: body["max_steps"] } : {}),
        })), true;
      } catch (err) {
        return send(400, { error: err instanceof Error ? err.message : String(err) }), true;
      }
    }
    const actionWait = p.match(/^\/api\/actions\/([^/]+)\/wait$/);
    if (req.method === "POST" && actionWait?.[1]) return send(200, await externalActions.wait(actionWait[1])), true;
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
    // One-time vendor sign-in (link-based). GET the page, POST start/finish, GET status.
    const loginPageMatch = p.match(/^\/login\/([^/]+)$/);
    if (req.method === "GET" && loginPageMatch?.[1]) return send(200, loginPage(decodeURIComponent(loginPageMatch[1])), "text/html; charset=utf-8"), true;
    const loginApi = p.match(/^\/api\/login\/([^/]+)\/(start|finish|status)$/);
    if (loginApi?.[1] && loginApi[2]) {
      const provider = decodeURIComponent(loginApi[1]);
      try {
        if (req.method === "POST" && loginApi[2] === "start") return send(200, await loginManager.start(provider)), true;
        if (req.method === "POST" && loginApi[2] === "finish") return send(200, await loginManager.finish(provider)), true;
        if (req.method === "GET" && loginApi[2] === "status") return send(200, loginManager.status(provider)), true;
      } catch (err) {
        return send(400, { error: err instanceof Error ? err.message : String(err) }), true;
      }
    }
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
    externalActions,
    orderTracker,
    orderWaiter,
    enrollments,
    log,
    close: async () => {
      await browsing.stop().catch(() => {});
      await approval.close().catch(() => {});
    },
  };
}

/** The CLI recovery /browse follows: the newest open one, else the newest that finished in the last 10 minutes. */
function latestCliRecovery(jobs: RecoveryJob[]): RecoveryJob | undefined {
  const cli = jobs.filter((j) => j.surface === "cli").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recent = (j: RecoveryJob) => Date.now() - Date.parse(j.events.at(-1)?.at ?? j.createdAt) < 10 * 60_000;
  return cli.find(isOpen) ?? cli.find(recent);
}

/** A CLI recovery on the browse page: its worker Steel browser and where it stands. */
function cliRecoveryView(job: RecoveryJob): { recoveryId: string; workerDebugUrl?: string; workerLabel?: string; recoveryNote: string } {
  const live = job.live;
  const label = live?.interactive
    ? live.takeoverReason === "LOGIN_REQUIRED"
      ? `Aisle needs you: sign in to ${job.namespace} here. The top-up continues automatically.`
      : "Aisle needs you: clear the verification here. Aisle then checks the balance."
    : `Aisle is topping up ${job.namespace} in this Steel browser (view only).`;
  let note: string;
  if (job.status === "awaiting_approval") note = `${job.checkpoint.tool} hit a billing wall. Review the card on the right and approve; the Steel browser opens here.`;
  else if (job.status === "running") note = live ? label : `Starting the Steel browser for ${job.namespace}…`;
  else if (job.status === "resolved") note = `Top-up verified by reading the balance. ${job.checkpoint.tool} was replayed and the agent continues.`;
  else note = `Recovery ${job.status}${job.refusal ? `: ${job.refusal.message}` : job.error ? `: ${job.error}` : ""}`;
  return { recoveryId: job.id, ...(live?.debugUrl ? { workerDebugUrl: live.debugUrl, workerLabel: label } : {}), recoveryNote: note };
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
  runtime: Pick<AisleRuntime, "gateway" | "log" | "orderTracker" | "orderWaiter"> & { externalActions?: ExternalActionManager },
  taskFor: (extra: { sessionId?: string }) => string,
): void {
  const { gateway, log, orderTracker, orderWaiter } = runtime;

  // MCP Apps: visual agents (Claude, ChatGPT) render the live top-up next to the tool call.
  // CLI agents ignore this and show the /browse link from the tool result instead.
  const widgetUi = { csp: RECOVERY_WIDGET_CSP, prefersBorder: true };
  server.registerResource(
    "aisle-recovery-widget",
    RECOVERY_WIDGET_URI,
    { title: "Aisle recovery", description: "The live Steel browser and status of an Aisle top-up.", mimeType: MCP_APP_MIME, _meta: { ui: widgetUi } },
    async () => ({ contents: [{ uri: RECOVERY_WIDGET_URI, mimeType: MCP_APP_MIME, text: RECOVERY_WIDGET_HTML, _meta: { ui: widgetUi } }] }),
  );
  const widgetMeta = { ui: { resourceUri: RECOVERY_WIDGET_URI }, "openai/outputTemplate": RECOVERY_WIDGET_URI };

  for (const tool of gateway.tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputShape, _meta: widgetMeta }, async (args, extra) =>
      gateway.callTool(tool.name, args as Record<string, unknown>, {
        taskId: taskFor(extra as unknown as Extra),
        progress: progressFor(extra as unknown as Extra, log),
      }),
    );
  }

  server.registerTool(
    "aisle__execute_web_action",
    {
      description: "Run a prompt-driven action on a SaaS in a local browser signed in with your saved profile — e.g. \"generate an image on textto-image\" or \"top up credits on higgsfield\". Name the vendor OR paste its https link; a bare name resolves to a vendor you've configured or logged in to (never a guessed domain). Works for any vendor with no merchant integration. Use it to generate/act or to top up on demand, not only after a 402. The model operates the site but never pays: any checkout goes through the normal one-approval Aisle top-up flow.",
      inputSchema: { prompt: z.string(), url: z.string().url().optional(), max_steps: z.number().int().positive().max(20).optional() },
      _meta: widgetMeta,
    },
    async ({ prompt, url, max_steps }, extra) => {
      if (!runtime.externalActions) return { content: [{ type: "text", text: JSON.stringify({ status: "RECOVERY_FAILED", error: "EXTERNAL_ACTIONS_NOT_CONFIGURED" }) }], isError: true };
      const result = await runtime.externalActions.execute({ taskId: taskFor(extra as unknown as Extra), prompt, ...(url === undefined ? {} : { url }), ...(max_steps === undefined ? {} : { maxSteps: max_steps }) });
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  server.registerTool(
    "aisle__wait_for_external_action",
    {
      description: "Wait for a prompt-driven external action after its top-up is approved. Do not repeat the original action.",
      inputSchema: { recovery_id: z.string() },
      _meta: widgetMeta,
    },
    async ({ recovery_id }) => {
      if (!runtime.externalActions) return { content: [{ type: "text", text: JSON.stringify({ status: "RECOVERY_FAILED", error: "EXTERNAL_ACTIONS_NOT_CONFIGURED" }) }], isError: true };
      const result = await runtime.externalActions.wait(recovery_id);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  server.registerTool(
    "aisle__wait_for_recovery",
    {
      description:
        "Wait for an Aisle recovery (a blocked tool call awaiting purchase approval) to finish. Call this with the recovery_id from an AWAITING_APPROVAL result. Do not re-run the original tool.",
      inputSchema: { recovery_id: z.string() },
      _meta: widgetMeta,
    },
    async ({ recovery_id }, extra) => gateway.waitForRecovery(recovery_id, progressFor(extra as unknown as Extra, log)),
  );

  server.registerTool(
    "aisle__recovery_status",
    {
      description:
        "Read-only status of an Aisle recovery (a billing-wall top-up): status, quote, the live Steel browser URL and recent events. Omit recovery_id for this session's latest. It never approves or buys anything.",
      inputSchema: { recovery_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ recovery_id }, extra) => gateway.recoveryStatus(taskFor(extra as unknown as Extra), recovery_id),
  );

  server.registerTool(
    "aisle__spend_report",
    { description: "Report what Aisle has spent and every recovery opened in this session." },
    async (extra) => gateway.spendReport(taskFor(extra as unknown as Extra)),
  );

  server.registerTool(
    "aisle__create_order",
    {
      description:
        "Create a tracked order for an agent task. Returns the order ID and current status.",
      inputSchema: {
        vendor: z.string(),
        amount: z.number().positive(),
        currency: z.string().default("USD"),
      },
    },
    async ({ vendor, amount, currency }, extra) => {
      const taskId = taskFor(extra as unknown as Extra);
      const now = new Date().toISOString();

      const order = await orderTracker.create({
        id: `order_${randomUUID()}`,
        agentId: "local-agent",
        taskId,
        vendor,
        status: "PENDING",
        amount,
        currency,
        createdAt: now,
        updatedAt: now,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(order),
          },
        ],
        structuredContent:
          order as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "aisle__get_order",
    {
      description:
        "Get the current status and details of a tracked order.",
      inputSchema: {
        order_id: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ order_id }) => {
      const order = await orderTracker.get(order_id);

      if (!order) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "NOT_FOUND",
                order_id,
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(order),
          },
        ],
        structuredContent:
          order as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "aisle__update_order_status",
    {
      description:
        "Update a tracked order's status and emit an order event.",
      inputSchema: {
        order_id: z.string(),
        status: z.enum([
          "PENDING",
          "CONFIRMED",
          "PROCESSING",
          "SHIPPED",
          "IN_TRANSIT",
          "OUT_FOR_DELIVERY",
          "DELIVERED",
          "CANCELLED",
          "EXCEPTION",
        ]),
      },
    },
    async ({ order_id, status }) => {
      const order = await orderTracker.updateStatus(
        order_id,
        status,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(order),
          },
        ],
        structuredContent:
          order as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "aisle__wait_for_order",
    {
      description:
        "Wait for a tracked order to receive its next status update.",
      inputSchema: {
        order_id: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ order_id }) => {
      try {
        const event = await orderWaiter.waitForOrder(order_id);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(event),
            },
          ],
          structuredContent:
            event as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "TIMEOUT",
                order_id,
                error:
                  err instanceof Error
                    ? err.message
                    : String(err),
              }),
            },
          ],
        };
      }
    },
  );

  // A slash command in MCP clients (Claude Code: /mcp__aisle__topup <request>) that
  // deterministically routes a request through Aisle — no tool ambiguity.
  server.registerPrompt(
    "topup",
    {
      title: "Aisle top-up / action",
      description: 'Do a paid action or top up credits on a SaaS via Aisle. Argument: what to do, naming the vendor or its link — e.g. "generate an image on textto-image".',
      argsSchema: { request: z.string().describe('What to do, e.g. "generate an image on textto-image" or "top up credits on higgsfield".') },
    },
    ({ request }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Call the aisle__execute_web_action tool with prompt: ${JSON.stringify(request)}. ` +
              `Use ONLY that tool — do not use any other image, media, or payment tool, because this must run through Aisle so any top-up gets one human approval. ` +
              `If the result is AWAITING_APPROVAL, show me the approve_url and recovery_id, then call aisle__wait_for_external_action with that recovery_id and wait until it resolves. ` +
              `When it resolves, report the final result and, if a purchase happened, a one-line spend note.`,
          },
        },
      ],
    }),
  );
}
