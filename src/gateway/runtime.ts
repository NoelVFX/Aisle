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
import { createAgnicClient } from "../agnic/client.js";
import { AgnicCommerceManager } from "../agnic/manager.js";
import { recommendTool } from "../agnic/recommend.js";
import { classifyTrack } from "../agnic/classify.js";
import { shopPage } from "../web/shop-page.js";
import { MCP_APP_MIME, RECOVERY_WIDGET_CSP, RECOVERY_WIDGET_HTML, RECOVERY_WIDGET_URI } from "./widget.js";

export interface AisleRuntime {
  root: string;
  stateDir: string;
  upstreams: Upstreams;
  gateway: Gateway;
  approval: ApprovalServer;
  browsing: BrowsingManager;
  externalActions?: ExternalActionManager;
  /** Agnic checkout rail (buy through any merchant's existing checkout). Present when AGNIC_TOKEN is set. */
  agnicCommerce?: AgnicCommerceManager;
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
  // Agnic checkout rail: buy through any merchant's existing checkout (hosted engine,
  // vaulted card, verifiable receipt). Present only when a server-side token is set.
  const agnicToken = process.env["AGNIC_TOKEN"];
  const agnicCommerce = agnicToken
    ? new AgnicCommerceManager({
        agnic: createAgnicClient(agnicToken, process.env["AGNIC_BASE_URL"] ? { baseUrl: process.env["AGNIC_BASE_URL"] } : {}),
        publicUrl: () => publicUrl,
        ...(process.env["AGNIC_DEFAULT_COUNTRY"] ? { defaultCountry: process.env["AGNIC_DEFAULT_COUNTRY"] } : {}),
      })
    : undefined;

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
    // Agnic purchase approval: GET the page, POST approve, GET status.
    const shopPageMatch = p.match(/^\/shop\/([^/]+)$/);
    if (req.method === "GET" && shopPageMatch?.[1]) {
      const pend = agnicCommerce?.pending(decodeURIComponent(shopPageMatch[1]));
      if (!pend) return send(404, "<h1>Unknown or expired purchase</h1>", "text/html; charset=utf-8"), true;
      const total = (() => { try { return new Intl.NumberFormat("en", { style: "currency", currency: pend.currency }).format(pend.total_minor / 100); } catch { return `${(pend.total_minor / 100).toFixed(2)} ${pend.currency}`; } })();
      return send(200, shopPage(decodeURIComponent(shopPageMatch[1]), pend.summary, total), "text/html; charset=utf-8"), true;
    }
    const shopApi = p.match(/^\/api\/shop\/([^/]+)\/(approve|status)$/);
    if (shopApi?.[1] && shopApi[2] && agnicCommerce) {
      const id = decodeURIComponent(shopApi[1]);
      if (req.method === "POST" && shopApi[2] === "approve") {
        const body = await readJson(req);
        const r = agnicCommerce.approve(id, typeof body["text"] === "string" ? body["text"] : undefined);
        return r.ok ? (send(200, r), true) : (send(400, r), true);
      }
      if (req.method === "GET" && shopApi[2] === "status") {
        const pend = agnicCommerce.pending(id);
        return send(pend ? 200 : 404, pend ?? { error: "UNKNOWN_SHOP" }), true;
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
    ...(agnicCommerce ? { agnicCommerce } : {}),
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
  runtime: Pick<AisleRuntime, "gateway" | "log"> & { externalActions?: ExternalActionManager; agnicCommerce?: AgnicCommerceManager },
  taskFor: (extra: { sessionId?: string }) => string,
): void {
  const { gateway, log } = runtime;

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
      description: "USE THIS TOOL to DO something on a SaaS the user already uses (signed in with their saved profile), or to top up credits on that site — e.g. \"generate an image on textto-image\", \"top up credits on higgsfield\", or \"use Aisle to top up on <site>\". This is for acting on / topping up an EXISTING account on a named site; to buy a NEW product or subscribe to a plan through checkout, use aisle__shop instead. Name the vendor OR paste its https link; a bare name resolves to a vendor you've configured or logged in to (never a guessed domain). Works for any vendor with no integration. The model operates the site but never pays: any checkout goes through the normal one-approval Aisle top-up flow.",
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

  // --- Agnic commerce rail: buy through any merchant's checkout with one approval. ---
  const agnicMissing = { content: [{ type: "text" as const, text: JSON.stringify({ status: "FAILED", error: "AGNIC_NOT_CONFIGURED: set AGNIC_TOKEN on the server to enable purchases." }) }], isError: true };
  const asJson = (obj: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }], structuredContent: obj as Record<string, unknown>, ...(isError ? { isError: true } : {}) });

  // The single smart entry: classify the ask (physical good vs digital SaaS/plan/credits)
  // and route to the right engine — Agnic's Shopify rail, the vendor's own browser
  // checkout, or (for a goal with no named vendor) discovery. The model never pays.
  server.registerTool(
    "aisle__buy",
    {
      description:
        "USE THIS as the ONE entry to buy anything with Aisle. It classifies the request — physical product vs digital SaaS/plan/credits — and automatically routes to the right checkout, so the user needn't say which. Prefer this for ANY \"buy / purchase / order / subscribe / top up …\" ask and whenever the user says \"use Aisle\". Examples: \"a hex token fidget\" (physical → Agnic), \"the Resend Pro plan\" or a pricing URL (SaaS → the vendor's own checkout), \"an MCP tool that sends email\" (goal → discovery). The model never pays; it returns an approval link and, for a goal, a recommendation to confirm first.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to buy, or the goal, in plain language."),
        country: z.string().length(2).optional().describe("Market for physical search: US, GB, CA, AU."),
        plan: z.string().optional().describe("Plan/tier for a SaaS, e.g. \"Pro\"."),
      },
      _meta: widgetMeta,
    },
    async ({ prompt, country, plan }, extra) => {
      const taskId = taskFor(extra as unknown as Extra);
      const classification = await classifyTrack(prompt);

      if (classification.track === "physical") {
        if (!runtime.agnicCommerce) return asJson({ track: "physical", status: "FAILED", classification, error: "AGNIC_NOT_CONFIGURED: set AGNIC_TOKEN to buy physical goods." }, true);
        const r = await runtime.agnicCommerce.shop({ taskId, prompt, ...(country ? { country } : {}), ...(plan ? { planHint: plan } : {}) });
        return asJson({ track: "physical", classification, ...r });
      }

      // SaaS: check out on the vendor's own site when a vendor/URL is resolvable; else discover.
      const target = runtime.externalActions?.resolveOrNull(prompt);
      if (runtime.externalActions && target) {
        const r = await runtime.externalActions.execute({ taskId, prompt });
        return asJson({ track: "saas", mode: "checkout", classification, ...r });
      }
      try {
        const rec = await recommendTool(prompt);
        return asJson({
          track: "saas",
          mode: "discover",
          classification,
          ...rec,
          next: `Recommended ${rec.tool_name} (${rec.checkout_url}). Show it to the user to confirm; then to buy it call aisle__buy again with the tool named and its URL in the prompt (e.g. "the ${rec.plan || "Pro"} plan on ${rec.checkout_url}"), which routes to the vendor's own checkout with one approval. Never pay without approval.`,
        });
      } catch (err) {
        return asJson({ track: "saas", mode: "discover", status: "FAILED", classification, error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );

  server.registerTool(
    "aisle__find_tool",
    {
      description:
        "USE THIS TOOL when the user wants a tool/SaaS/MCP server for a GOAL but hasn't named a specific product — e.g. \"I want an MCP tool that sends email autonomously\", \"what should I use to add payments?\", \"find me a SaaS for X\", or \"use Aisle to find a tool for …\". It recommends the best-fit tool and returns its checkout URL + suggested plan: { tool_name, checkout_url, plan, why, alternatives }. Show the user the pick, then to buy it call aisle__shop with explore_url = checkout_url and plan = the suggested plan. This only names a tool and a URL — it never pays.",
      inputSchema: { goal: z.string().min(1).describe("What the user wants a tool to do.") },
      annotations: { readOnlyHint: true },
    },
    async ({ goal }) => {
      try {
        const rec = await recommendTool(goal);
        const result = {
          status: "RECOMMENDED",
          ...rec,
          next: `Show the user "${rec.tool_name}" (${rec.checkout_url}) and its rationale. To buy its plan, call aisle__shop with explore_url set to that checkout_url and plan set to ${JSON.stringify(rec.plan || "the tier the user wants")}. If it returns CHOOSE_PLAN, show the plans and let the user pick, then call aisle__shop again with merchant_id + the chosen sku. The user still approves before anything is charged.`,
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (err) {
        const result = { status: "FAILED", error: err instanceof Error ? err.message : String(err) };
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true };
      }
    },
  );

  server.registerTool(
    "aisle__shop",
    {
      description:
        "USE THIS TOOL to buy, purchase, order, check out, or pay for anything — a product, a SaaS/MCP plan or subscription, or a credits pack — through a real merchant's existing checkout (Agnic rail, no merchant integration). This is Aisle's purchase tool: it is the correct choice for ANY request like \"buy me …\", \"purchase …\", \"order …\", \"get me …\", \"subscribe to …\", or \"check out …\", and ALWAYS when the user says \"use Aisle\" / \"with Aisle\" to buy something. Do NOT use a generic web/browser/search tool for a purchase — use this. Describe the item in `prompt` (e.g. \"a hex token fidget\"); optionally pin merchant_id + sku, or pass explore_url (a SaaS pricing page) to onboard the shop and read its plans from Agnic's catalogue. With several plans it returns CHOOSE_PLAN { merchant_id, plans } — show them and let the USER pick (the optional `plan` only ranks them, never picks), then call again with merchant_id + the chosen sku. The model never pays — it returns AWAITING_APPROVAL with an approve link; after the user approves, call aisle__wait_for_purchase. Ends at a receipt.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to buy, in plain language."),
        country: z.string().length(2).optional().describe("Market for search: US, GB, CA or AU."),
        merchant_id: z.string().optional().describe("Skip search: buy from this merchant."),
        sku: z.string().optional().describe("The exact product to buy (with merchant_id or explore_url)."),
        quantity: z.number().int().positive().max(50).optional(),
        explore_url: z.string().url().optional().describe("Onboard this shop (Explore) before buying — e.g. a SaaS pricing page."),
        plan: z.string().optional().describe("With explore_url: the plan that likely fits, e.g. \"Pro\". Only ranks the CHOOSE_PLAN list; never picks a plan."),
      },
      _meta: widgetMeta,
    },
    async ({ prompt, country, merchant_id, sku, quantity, explore_url, plan }, extra) => {
      if (!runtime.agnicCommerce) return agnicMissing;
      const result = await runtime.agnicCommerce.shop({
        taskId: taskFor(extra as unknown as Extra),
        prompt,
        ...(country ? { country } : {}),
        ...(merchant_id ? { merchantId: merchant_id } : {}),
        ...(sku ? { sku } : {}),
        ...(quantity ? { quantity } : {}),
        ...(explore_url ? { exploreUrl: explore_url } : {}),
        ...(plan ? { planHint: plan } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  server.registerTool(
    "aisle__wait_for_purchase",
    {
      description:
        "After the user approves a purchase (from aisle__shop's AWAITING_APPROVAL), place and follow the order and return the receipt. Poll this with the shop_id; do NOT re-run aisle__shop. If it returns APPROVAL_REQUIRED, show the link, let the user complete the step-up, then call this again.",
      inputSchema: { shop_id: z.string() },
      _meta: widgetMeta,
    },
    async ({ shop_id }) => {
      if (!runtime.agnicCommerce) return agnicMissing;
      const result = await runtime.agnicCommerce.wait(shop_id);
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

  // A slash command (Claude Code: /mcp__aisle__buy <request>) that deterministically
  // routes a PURCHASE through Aisle's Agnic checkout rail — no tool ambiguity, so the
  // agent never wanders off to some other shopping/web skill.
  server.registerPrompt(
    "buy",
    {
      title: "Aisle buy (Agnic checkout)",
      description: 'Buy a product, plan, or credits through Aisle\'s Agnic checkout, or find the best tool for a goal first. Argument: what to buy or the goal — e.g. "a hex token fidget" or "an MCP tool that sends email autonomously".',
      argsSchema: { request: z.string().describe('What to buy or the goal, e.g. "a hex token fidget" or "an email-sending MCP tool".') },
    },
    ({ request }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Complete this purchase through Aisle's Agnic checkout rail ONLY. Request: ${JSON.stringify(request)}. ` +
              `Do NOT use any other shopping, browser, payment, or marketplace tool — it must go through Aisle so it gets exactly one human approval and a verifiable receipt.\n` +
              `1. If the request describes a GOAL or a need for a tool (e.g. "an MCP tool that sends email") rather than a specific product, first call aisle__find_tool with goal set to the request, then show me the recommended tool and its checkout_url. If it is already a concrete product, skip this step.\n` +
              `2. Call aisle__shop with prompt set to the request. If you used aisle__find_tool, also pass explore_url set to its checkout_url and plan set to its suggested plan. Pass merchant_id/sku only if I gave them.\n` +
              `3. If aisle__shop returns CHOOSE_PLAN, show me the plan options and call aisle__shop again with the same explore_url plus the sku I pick. On AWAITING_APPROVAL, show me the summary, total, and approve_url, then STOP and wait — I approve on that page. Never place payment yourself.\n` +
              `4. After I approve, call aisle__wait_for_purchase with the shop_id and poll it. If it returns APPROVAL_REQUIRED, show me the link, let me finish it, then call aisle__wait_for_purchase again. Do NOT re-run aisle__shop.\n` +
              `5. When COMPLETED, show me the receipt (order id, amount, currency, status).`,
          },
        },
      ],
    }),
  );
}
