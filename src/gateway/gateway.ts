/**
 * The intercept (aisle-pipeline.md §5.4, §5.5, §19).
 *
 * Every vendor tool call goes through `callTool`. Ordinary errors pass through
 * untouched. A billing wall opens a recovery and the call BLOCKS: the agent gets
 * the real result after recovery, or AWAITING_APPROVAL with an instruction to
 * call aisle__wait_for_recovery, never to re-run the original tool.
 */

import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { classifyFailure, isRateLimitNotWall, registerVendorRules } from "../classifier.js";
import { normalizeError, type NormalizedError } from "../error-normalizer.js";
import {
  RecoveryCoordinator,
  type FastPurchaser,
  type RecoveryJob,
  type SteelPurchaser,
  type SteelRunner,
  type TimelineEvent,
} from "./recovery.js";
import {
  openAiChatTool,
  openRouterChatTool,
  higgsfieldTool,
  studioImageTool,
  type FetchLike,
  type UpstreamResult,
  type Upstreams,
  type VendorTool,
} from "./upstreams.js";

/**
 * OpenAI's "no credits" bodies, both seen live:
 *   429 { error: { type: "insufficient_quota", code: "credit_balance_exhausted", message: "You have no credits remaining…" } }
 *   429 { error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota…" } }
 */
const OPENAI_NO_CREDIT_CODES = new Set(["insufficient_quota", "credit_balance_exhausted"]);
registerVendorRules("openai", [
  {
    test: (e) => {
      const type = e.body !== null && typeof e.body === "object" ? (e.body as { type?: unknown }).type : undefined;
      return (
        (e.code !== undefined && OPENAI_NO_CREDIT_CODES.has(e.code)) ||
        type === "insufficient_quota" ||
        /no credits remaining|exceeded your current quota/i.test(e.message ?? "")
      );
    },
    type: "INSUFFICIENT_CREDITS",
    resource: "usd_balance",
  },
]);

/**
 * Higgsfield, per the docs' example (aisle-pipeline.md §6). ⚠ VERIFY the real body
 * against a drained account and tighten.
 */
registerVendorRules("higgsfield", [
  {
    test: (e) => {
      const bodyText = e.body === undefined || e.body === null ? "" : JSON.stringify(e.body);
      return (
        e.code === "insufficient_credits" ||
        /insufficient credits|not enough credits|not[_ -]?enough[_ -]?credits/i.test(`${e.message ?? ""} ${bodyText}`)
      );
    },
    type: "INSUFFICIENT_CREDITS",
    resource: "image_credits",
    required: (e) => {
      const v = e.body !== null && typeof e.body === "object" ? (e.body as Record<string, unknown>)["required_credits"] : undefined;
      return typeof v === "number" ? v : undefined;
    },
  },
]);

/**
 * OpenRouter: 402 { error: { code: 402, message: "Insufficient credits. …" } } on
 * paid models (API and openrouter.ai/chat alike). ⚠ VERIFY against a drained account.
 */
registerVendorRules("openrouter", [
  {
    test: (e) => e.status === 402 || /insufficient credits|requires more credits|never purchased credits/i.test(e.message ?? ""),
    type: "INSUFFICIENT_CREDITS",
    resource: "usd_balance",
  },
]);

/** Studio (Stripe test-mode demo vendor): 402 { error: { code: "insufficient_credits", required_credits } }. */
registerVendorRules("studio", [
  {
    test: (e) => e.code === "insufficient_credits",
    type: "INSUFFICIENT_CREDITS",
    resource: "image_credits",
    required: (e) => {
      const v = e.body !== null && typeof e.body === "object" ? (e.body as Record<string, unknown>)["required_credits"] : undefined;
      return typeof v === "number" ? v : undefined;
    },
  },
]);

/** OpenAI rate limits are 429 too. Buying credits does not fix them. */
const isOpenAiRateLimit = (ns: string, e: NormalizedError): boolean =>
  ns === "openai" && e.status === 429 && e.code === "rate_limit_exceeded";

export interface GatewayOptions {
  upstreams: Upstreams;
  steel: SteelRunner;
  purchaser?: SteelPurchaser;
  fastPurchaser?: FastPurchaser;
  /** Extra vendor tools (tests, future vendors). OpenAI is always registered. */
  extraTools?: VendorTool[];
  /** Vendor balance APIs: the entitlement check before the quote, and Gate 2. */
  balanceReaders?: Readonly<Record<string, () => Promise<number | undefined>>>;
  /** Where the user approves. The runtime sends CLI recoveries to the browse page. */
  approveUrlFor?: (recoveryId: string, surface: "cli" | "web") => string;
  realPurchaseProviders?: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** How long a blocked call holds open. Keep it under the MCP client's tool timeout. */
  safeBlockMs?: number;
  pollMs?: number;
  publicUrl: () => string;
  mandateSecret?: string;
  onEvent?: (job: RecoveryJob, event: TimelineEvent) => void;
  onApprovalRequested?: (job: RecoveryJob) => void;
  onSteelLive?: (job: RecoveryJob) => void;
  log?: (message: string) => void;
}

export type Progress = (message: string) => Promise<void>;

export function createGateway(options: GatewayOptions) {
  const env = options.env ?? process.env;
  const log = options.log ?? ((m: string) => console.error(m));
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const safeBlockMs = options.safeBlockMs ?? (Number(env["SAFE_BLOCK_MS"]) || 50_000);
  // Return the approval link quickly on the first call. The follow-up
  // aisle__wait_for_recovery call uses safeBlockMs and can wait for completion.
  const initialBlockMs = Number(env["AISLE_INITIAL_BLOCK_MS"]) || 3_000;

  const studioUrl = options.upstreams["studio"]?.toolUrl;
  const tools: VendorTool[] = [
    openAiChatTool(env, fetchImpl),
    openRouterChatTool(env, fetchImpl),
    ...(((env["HIGGSFIELD_API_KEY_ID"] && env["HIGGSFIELD_API_KEY_SECRET"]) || env["HIGGSFIELD_API_KEY"]?.includes(":")) ? [higgsfieldTool(env, fetchImpl)] : []),
    ...(studioUrl ? [studioImageTool(studioUrl, env, fetchImpl)] : []),
    ...(options.extraTools ?? []),
  ].filter(
    (t) => options.upstreams[t.namespace] !== undefined,
  );

  const coordinator = new RecoveryCoordinator({
    upstreams: options.upstreams,
    steel: options.steel,
    publicUrl: options.publicUrl,
    ...(options.balanceReaders === undefined ? {} : { balanceReaders: options.balanceReaders }),
    ...(options.approveUrlFor === undefined ? {} : { approveUrlFor: options.approveUrlFor }),
    ...(options.purchaser === undefined ? {} : { purchaser: options.purchaser }),
    ...(options.fastPurchaser === undefined ? {} : { fastPurchaser: options.fastPurchaser }),
    ...(options.realPurchaseProviders === undefined ? {} : { realPurchaseProviders: options.realPurchaseProviders }),
    ...(options.mandateSecret === undefined ? {} : { mandateSecret: options.mandateSecret }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    ...(options.onApprovalRequested === undefined ? {} : { onApprovalRequested: options.onApprovalRequested }),
    ...(options.onSteelLive === undefined ? {} : { onSteelLive: options.onSteelLive }),
  });

  const text = (value: unknown, isError = false): CallToolResult => ({
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError,
  });

  /** Ordinary errors go back exactly as the vendor sent them. */
  const passThrough = (r: Extract<UpstreamResult, { ok: false }>): CallToolResult =>
    text({ status: r.status, error: r.body }, true);

  /**
   * Gateway error envelope for the classifier. OpenAI nests its error one level
   * down ({ error: { code, message } }), so unwrap it; flat bodies pass as-is.
   */
  const envelope = (r: Extract<UpstreamResult, { ok: false }>) => {
    const body = r.body as { error?: unknown } | null;
    const inner = body !== null && typeof body === "object" && body.error !== null && typeof body.error === "object" ? body.error : r.body;
    return { isError: true, status: r.status, headers: r.headers, error: inner };
  };

  async function callTool(name: string, args: Record<string, unknown>, ctx: { taskId: string; progress?: Progress }): Promise<CallToolResult> {
    const tool = tools.find((t) => t.name === name);
    if (!tool) return text(`Unknown tool: ${name}`, true);
    const ns = tool.namespace;
    const progress: Progress = ctx.progress ?? (async () => {});
    log(`[aisle] TOOL_CALL_STARTED ${name}`);

    let result = await tool.call(args);

    // The 429 guard: a rate limit is not a wall. Sleep and retry once; never buy.
    if (!result.ok) {
      const e = normalizeError(envelope(result));
      if (isRateLimitNotWall(e.status, e.retryAfterSeconds) || isOpenAiRateLimit(ns, e)) {
        const waitS = Math.min(e.retryAfterSeconds ?? 2, 10);
        log(`[aisle] RATE_LIMITED ${name}: retrying once in ${waitS}s, not a billing wall`);
        await progress(`Rate limited by ${ns}; retrying in ${waitS}s (no purchase).`);
        await new Promise((r) => setTimeout(r, waitS * 1000));
        result = await tool.call(args);
        if (!result.ok && (isOpenAiRateLimit(ns, normalizeError(envelope(result))) || result.status === 429)) {
          return passThrough(result);
        }
      }
    }

    if (result.ok) {
      log(`[aisle] TOOL_CALL_SUCCEEDED ${name}`);
      return text(result.text);
    }

    const classified = classifyFailure(envelope(result), { provider: ns });
    if (!classified.recoverable) {
      log(`[aisle] TOOL_CALL_FAILED ${name}: ${classified.classification} (not a billing wall, passed through untouched)`);
      return passThrough(result);
    }

    // §16.5: Aisle's own resolver key is infrastructure, never recoverable.
    const upstream = options.upstreams[ns];
    const vendorKey = upstream?.authEnv ? env[upstream.authEnv] : undefined;
    if (vendorKey && env["OPENROUTER_INFRA_KEY"] && vendorKey === env["OPENROUTER_INFRA_KEY"]) {
      log(`[aisle] INFRA_CREDITS_EXHAUSTED ${ns}: refusing to open a recovery job`);
      return text("INFRA_BLOCKED: this key is Aisle's own infrastructure key and cannot be recovered. Top up manually.", true);
    }

    log(`[aisle] BILLING_WALL ${name}: ${classified.classification} → opening recovery`);
    const job = await coordinator.open({
      taskId: ctx.taskId,
      toolCallId: randomUUID(),
      namespace: ns,
      tool: name,
      arguments: args,
      blocker: classified.blocker,
    });
    await progress(`Blocked on ${ns} (${classified.classification}). Aisle opened a recovery. Approve here: ${job.approveUrl}`);
    return block(job, progress, initialBlockMs);
  }

  async function block(job: RecoveryJob, progress: Progress, timeoutMs = safeBlockMs): Promise<CallToolResult> {
    const final = await coordinator.wait(job.id, timeoutMs, (j) => {
      const last = j.events[j.events.length - 1];
      return progress(last ? `${last.type} ${JSON.stringify(last.detail)}` : j.status);
    });
    return finish(final);
  }

  async function finish(job: RecoveryJob): Promise<CallToolResult> {
    switch (job.status) {
      case "awaiting_approval":
      case "running":
        return text({
          status: job.status === "running" ? "RECOVERY_RUNNING" : "AWAITING_APPROVAL",
          recovery_id: job.id,
          approve_url: job.approveUrl,
          quote: job.quote?.reason,
          session: job.session.status,
          plans: job.plans && {
            selected: job.selectedPlanId,
            recommended: job.plans.recommended,
            alternatives: job.plans.alternatives,
            how_to_choose: "The user picks a plan and approves on the approval page. Do not choose for them.",
          },
          next: "Call aisle__wait_for_recovery with this recovery_id. Do NOT re-run the original tool.",
        });

      case "resolved": {
        // Replay the EXACT same call. Never regenerate the request.
        const tool = tools.find((t) => t.name === job.checkpoint.tool);
        if (!tool) return text(`Recovery resolved but tool ${job.checkpoint.tool} is gone.`, true);
        const replay = await tool.call(job.checkpoint.arguments as Record<string, unknown>);
        log(`[aisle] TOOL_CALL_RETRIED ${tool.name} → ${replay.ok ? "succeeded" : `failed ${replay.status}`}`);
        if (!replay.ok) return passThrough(replay);
        log(`[aisle] TASK_RESUMED ${job.taskId}`);
        return text(replay.text);
      }

      case "dry_run_complete":
        return text({
          status: "DRY_RUN_COMPLETE",
          recovery_id: job.id,
          blocked_tool: job.checkpoint.tool,
          blocker: job.checkpoint.blocker.type,
          would_buy: job.quote && { product: job.quote.productId, price: job.quote.price, currency: job.quote.currency, reason: job.quote.reason },
          steel: job.steel,
          note:
            "Aisle detected the billing wall and opened a Steel browser session on the locked billing origin. " +
            "No purchase was made, so the original call was not replayed and will still fail. Tell the user.",
        });

      case "staged_not_submitted":
        return text({
          status: "STAGED_NOT_SUBMITTED",
          recovery_id: job.id,
          blocked_tool: job.checkpoint.tool,
          staged: job.staged,
          cap: job.mandate?.maximumAmount,
          note:
            "Aisle staged the checkout in a Steel browser and it matched the approved mandate, but real-money submit is " +
            "not enabled for this vendor (AISLE_REAL_PURCHASE_PROVIDERS). Nothing was charged and the original call was " +
            "not replayed. Tell the user.",
        });

      case "refused":
        return text({ status: "REFUSED", recovery_id: job.id, reason: job.refusal?.reason, message: job.refusal?.message, detail: job.refusal?.detail });

      case "rejected":
        return text({ status: "REJECTED", recovery_id: job.id, message: "The user declined the purchase. Do not retry the original tool." });

      case "failed":
        return text({ status: "RECOVERY_FAILED", recovery_id: job.id, error: job.error }, true);
    }
  }

  async function waitForRecovery(recoveryId: string, progress?: Progress): Promise<CallToolResult> {
    const job = coordinator.get(recoveryId);
    if (!job) return text(`Unknown recovery_id: ${recoveryId}`, true);

    // A model may invoke the follow-up wait tool in the same turn before the
    // human has had a chance to open/approve the billing page. Do not hold the
    // MCP request open in that state: return the approval envelope immediately
    // so the URL and recovery_id reach the user. Once approval is granted,
    // waiting is safe and will block until the recovery resolves or times out.
    if (job.status === "awaiting_approval") return finish(job);

    return block(job, progress ?? (async () => {}));
  }

  /**
   * Read-only view of a recovery for the in-chat widget and for agents: the given one,
   * else this task's newest. Never approves or changes anything.
   */
  function recoveryStatus(taskId: string, recoveryId?: string): CallToolResult {
    const job = recoveryId
      ? coordinator.get(recoveryId)
      : coordinator
          .list()
          .filter((j) => j.taskId === taskId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!job) return { content: [{ type: "text", text: JSON.stringify({ status: "NO_RECOVERY" }) }], structuredContent: { status: "NO_RECOVERY" } };
    const view = {
      recovery_id: job.id,
      status: job.status,
      session: job.session.status,
      vendor: job.namespace,
      blocked_tool: job.checkpoint.tool,
      blocker: job.checkpoint.blocker.type,
      approve_url: job.approveUrl,
      quote: job.quote ? { reason: job.quote.reason, price: job.quote.price, currency: job.quote.currency } : null,
      cap: job.mandate?.maximumAmount ?? null,
      lane: job.lane ?? null,
      live: job.live ? { debug_url: job.live.debugUrl ?? null, interactive: job.live.interactive === true, takeover_reason: job.live.takeoverReason ?? null } : null,
      error: job.error ?? null,
      refusal: job.refusal?.message ?? null,
      events: job.events.slice(-12).map((e) => ({ at: e.at, type: e.type })),
    };
    return { content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view };
  }

  async function spendReport(taskId: string): Promise<CallToolResult> {
    const spend = await coordinator.spendFor(taskId);
    const jobs = coordinator.list().filter((j) => j.taskId === taskId);
    return text({
      task_id: taskId,
      spend,
      recoveries: jobs.map((j) => ({ id: j.id, tool: j.checkpoint.tool, status: j.status, lane: j.lane, price: j.quote?.price })),
    });
  }

  return { tools, coordinator, callTool, waitForRecovery, spendReport, recoveryStatus };
}

export type Gateway = ReturnType<typeof createGateway>;
