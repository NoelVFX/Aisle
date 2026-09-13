/**
 * Prompt-driven external web actions.
 *
 * A link in a prompt is not trusted as a payment origin. It is only used to
 * select a configured upstream; money and recovery origins still come from
 * upstreams.json. The action itself runs in a short-lived Steel worker with
 * computer-use, and billing walls are handed to the existing coordinator.
 */

import { randomUUID } from "node:crypto";
import Steel from "steel-sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import { classifyFailure } from "../classifier.js";
import type { Blocker } from "../types.js";
import type { UpstreamEntry, Upstreams } from "../gateway/upstreams.js";
import type { RecoveryCoordinator, RecoveryJob } from "../gateway/recovery.js";
import { SteelComputerControl } from "../slow-lane/steel-computer.js";
import { createOpenRouterComputerUseAgent, type ComputerUseAgent } from "../slow-lane/computer-use.js";

export interface ExternalActionRequest {
  taskId: string;
  prompt: string;
  url?: string;
  maxSteps?: number;
}

export interface ExternalActionTarget {
  url: string;
  provider: string;
  upstream: UpstreamEntry;
}

export type ExternalActionAttempt =
  | { kind: "completed"; note: string; finalUrl: string; viewerUrl?: string }
  | { kind: "billing_wall"; blocker: Blocker; finalUrl: string; viewerUrl?: string };

export interface ExternalActionExecutor {
  run(input: ExternalActionRequest & ExternalActionTarget): Promise<ExternalActionAttempt>;
}

export type ExternalActionResult =
  | { status: "COMPLETED"; provider: string; note: string; final_url: string; viewer_url?: string }
  | { status: "AWAITING_APPROVAL"; recovery_id: string; approve_url: string; provider: string; next: string }
  | { status: "RECOVERY_RUNNING"; recovery_id: string; provider: string }
  | { status: "RECOVERY_FAILED"; recovery_id: string; error?: string };

const URL_RE = /https?:\/\/[^\s<>()]+/gi;

/** Extract the first HTTP(S) URL from a prompt, stripping common punctuation. */
export function extractPromptUrl(prompt: string): string | undefined {
  const raw = prompt.match(URL_RE)?.[0];
  if (!raw) return undefined;
  return raw.replace(/[),.;!?]+$/, "");
}

/** Match only configured canonical or billing origins. Never accepts an arbitrary prompt origin. */
export function resolveExternalTarget(prompt: string, upstreams: Upstreams, explicitUrl?: string): ExternalActionTarget {
  const url = explicitUrl ?? extractPromptUrl(prompt);
  if (!url) throw new Error("URL_REQUIRED: paste an http(s) service link in the prompt.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("INVALID_URL: the external service link must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("HTTPS_REQUIRED: external service links must use HTTPS.");
  }
  const found = Object.entries(upstreams).find(([, upstream]) => {
    try {
      return new URL(upstream.canonicalOrigin).origin === parsed.origin || new URL(upstream.billingOrigin).origin === parsed.origin;
    } catch {
      return false;
    }
  });
  if (!found) throw new Error(`UNENROLLED_ORIGIN: ${parsed.origin} is not a configured Aisle vendor.`);
  return { url: parsed.toString(), provider: found[0], upstream: found[1] };
}

export class ExternalActionManager {
  private readonly actions = new Map<string, ExternalActionRequest & ExternalActionTarget>();

  constructor(
    private readonly deps: {
      upstreams: Upstreams;
      coordinator: RecoveryCoordinator;
      executor: ExternalActionExecutor;
    },
  ) {}

  async execute(request: ExternalActionRequest): Promise<ExternalActionResult> {
    const target = resolveExternalTarget(request.prompt, this.deps.upstreams, request.url);
    const full = { ...request, ...target };
    const attempt = await this.deps.executor.run(full);
    if (attempt.kind === "completed") return { status: "COMPLETED", provider: target.provider, note: attempt.note, final_url: attempt.finalUrl, ...(attempt.viewerUrl ? { viewer_url: attempt.viewerUrl } : {}) };

    const job = await this.deps.coordinator.open({
      taskId: request.taskId,
      toolCallId: randomUUID(),
      namespace: target.provider,
      tool: "aisle__execute_web_action",
      arguments: { prompt: request.prompt, url: target.url, maxSteps: request.maxSteps },
      blocker: attempt.blocker,
      surface: "web",
    });
    this.actions.set(job.id, full);
    return this.status(job);
  }

  async wait(recoveryId: string): Promise<ExternalActionResult> {
    let job = this.deps.coordinator.get(recoveryId);
    if (!job) return { status: "RECOVERY_FAILED", recovery_id: recoveryId, error: "UNKNOWN_RECOVERY" };
    if (job.status === "awaiting_approval") return this.status(job);
    if (job.status === "running") {
      job = await this.deps.coordinator.wait(recoveryId, 30_000);
      if (job.status === "running") return { status: "RECOVERY_RUNNING", recovery_id: job.id, provider: job.namespace };
    }
    if (job.status !== "resolved") return { status: "RECOVERY_FAILED", recovery_id: job.id, error: job.error ?? job.status };

    const request = this.actions.get(job.id);
    if (!request) return { status: "RECOVERY_FAILED", recovery_id: job.id, error: "ACTION_CHECKPOINT_MISSING" };
    const attempt = await this.deps.executor.run(request);
    if (attempt.kind === "billing_wall") return { status: "RECOVERY_FAILED", recovery_id: job.id, error: "BILLING_WALL_REMAINED_AFTER_TOP_UP" };
    this.actions.delete(job.id);
    return { status: "COMPLETED", provider: request.provider, note: attempt.note, final_url: attempt.finalUrl, ...(attempt.viewerUrl ? { viewer_url: attempt.viewerUrl } : {}) };
  }

  private status(job: RecoveryJob): ExternalActionResult {
    if (job.status === "awaiting_approval") {
      return {
        status: "AWAITING_APPROVAL",
        recovery_id: job.id,
        approve_url: job.approveUrl,
        provider: job.namespace,
        next: "Approve the top-up, then call aisle__wait_for_external_action with this recovery_id. Do not repeat the original prompt.",
      };
    }
    return { status: "RECOVERY_RUNNING", recovery_id: job.id, provider: job.namespace };
  }
}

/** Steel implementation used by the SaaS path. The model may operate the site, but never pay. */
export class SteelExternalActionExecutor implements ExternalActionExecutor {
  constructor(
    private readonly options: {
      apiKey?: string;
      agent?: ComputerUseAgent;
      maxSteps?: number;
      sessionTimeoutMs?: number;
    } = {},
  ) {}

  async run(input: ExternalActionRequest & ExternalActionTarget): Promise<ExternalActionAttempt> {
    const apiKey = this.options.apiKey ?? process.env["STEEL_API_KEY"];
    if (!apiKey) throw new Error("STEEL_API_KEY is required for prompt-driven web actions.");
    const agent = this.options.agent ?? createOpenRouterComputerUseAgent();
    const client = new Steel({ steelAPIKey: apiKey });
    const session = await client.sessions.create({
      timeout: this.options.sessionTimeoutMs ?? 15 * 60_000,
      useProxy: true,
      solveCaptcha: true,
      dimensions: { width: 1280, height: 720 },
      debugConfig: { interactive: true, systemCursor: true },
      credentials: { autoSubmit: true, blurFields: true },
    });
    let browser: Browser | undefined;
    let wall: Blocker | undefined;
    try {
      browser = await chromium.connectOverCDP(session.websocketUrl);
      const page = browser.contexts()[0]?.pages()[0];
      if (!page) throw new Error("STEEL_NO_PAGE: Steel returned no browser page.");
      page.on("response", (response) => {
        if (wall || ![402, 403, 429].includes(response.status())) return;
        void (async () => {
          const bodyText = await response.text().catch(() => "");
          let body: unknown = bodyText;
          try { body = JSON.parse(bodyText) as unknown; } catch { /* plain text */ }
          const classified = classifyFailure({ status: response.status(), headers: response.headers(), error: body }, { provider: input.provider, bodyAvailable: true });
          if (classified.recoverable) wall = classified.blocker;
        })();
      });
      await page.goto(input.url, { waitUntil: "domcontentloaded" });
      const details = await client.sessions.retrieve(session.id).catch(() => undefined);
      const viewerUrl = details?.debugUrl ?? session.sessionViewerUrl;
      const control = new SteelComputerControl(client, session.id, { width: 1280, height: 720 }, () => page.url());
      const outcome = await agent.run(control, input.prompt, { maxSteps: input.maxSteps ?? this.options.maxSteps });
      if (wall) return { kind: "billing_wall", blocker: wall, finalUrl: page.url(), ...(viewerUrl ? { viewerUrl } : {}) };
      return { kind: "completed", note: outcome.note ?? (outcome.success ? "External web action completed." : "External web action stopped before completion."), finalUrl: page.url(), ...(viewerUrl ? { viewerUrl } : {}) };
    } finally {
      await browser?.close().catch(() => {});
      await client.sessions.release(session.id).catch(() => {});
    }
  }
}
