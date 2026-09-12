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
  type RecoveryJob,
  type SteelRunner,
  type TimelineEvent,
} from "./recovery.js";
import { MockImageVendor, openAiChatTool, type FetchLike, type UpstreamResult, type Upstreams, type VendorTool } from "./upstreams.js";

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

/** OpenAI rate limits are 429 too. Buying credits does not fix them. */
const isOpenAiRateLimit = (ns: string, e: NormalizedError): boolean =>
  ns === "openai" && e.status === 429 && e.code === "rate_limit_exceeded";

export interface GatewayOptions {
  upstreams: Upstreams;
  steel: SteelRunner;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  mockVendor?: MockImageVendor;
  /** How long a blocked call holds open. Keep it under the MCP client's tool timeout. */
  safeBlockMs?: number;
  pollMs?: number;
  publicUrl: () => string;
  mandateSecret?: string;
  onEvent?: (job: RecoveryJob, event: TimelineEvent) => void;
  onApprovalRequested?: (job: RecoveryJob) => void;
  log?: (message: string) => void;
}

export type Progress = (message: string) => Promise<void>;

export function createGateway(options: GatewayOptions) {
  const env = options.env ?? process.env;
  const log = options.log ?? ((m: string) => console.error(m));
  const mock = options.mockVendor ?? new MockImageVendor(Number(env["AISLE_MOCK_START_BALANCE"] ?? 0) || 0);
  const safeBlockMs = options.safeBlockMs ?? (Number(env["SAFE_BLOCK_MS"]) || 50_000);

  const tools: VendorTool[] = [
    openAiChatTool(env, options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)),
    mock.tool(),
  ].filter((t) => options.upstreams[t.namespace] !== undefined);

  const coordinator = new RecoveryCoordinator({
    upstreams: options.upstreams,
    steel: options.steel,
    publicUrl: options.publicUrl,
    fakeCredit: (ns, units) => {
      if (ns !== "mockvendor") return false;
      mock.credit(units);
      return true;
    },
    ...(options.mandateSecret === undefined ? {} : { mandateSecret: options.mandateSecret }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    ...(options.onApprovalRequested === undefined ? {} : { onApprovalRequested: options.onApprovalRequested }),
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
    return block(job, progress);
  }

  async function block(job: RecoveryJob, progress: Progress): Promise<CallToolResult> {
    const final = await coordinator.wait(job.id, safeBlockMs, (j) => {
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
    return block(job, progress ?? (async () => {}));
  }

  async function spendReport(taskId: string): Promise<CallToolResult> {
    const spend = await coordinator.spendFor(taskId);
    const jobs = coordinator.list().filter((j) => j.taskId === taskId);
    return text({
      task_id: taskId,
      spend,
      recoveries: jobs.map((j) => ({ id: j.id, tool: j.checkpoint.tool, status: j.status, price: j.quote?.price })),
    });
  }

  return { tools, coordinator, callTool, waitForRecovery, spendReport, mock };
}

export type Gateway = ReturnType<typeof createGateway>;
