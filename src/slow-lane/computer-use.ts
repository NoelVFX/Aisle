/**
 * Computer-use resolver (aisle-pipeline.md §16, §17).
 *
 * Executor: Steel (`sessions.computer`, see steel-computer.ts) or Playwright.
 * Brain: OpenRouter, default model NVIDIA Nemotron 3 Nano Omni (free, vision).
 *
 * When a READ or STAGING step can't complete deterministically, the worker hands
 * the stuck sub-goal to a `ComputerUseAgent`, which drives the browser by
 * screenshots + pixel actions.
 *
 * Hard rules from the docs:
 *   - A model is never in the final submit, the gate, the origin decision, the
 *     mandate comparison, or verification. The worker never calls this for confirm.
 *   - The model provider driving recovery is INFRASTRUCTURE, keyed by
 *     OPENROUTER_INFRA_KEY. If it 402s, fail loud with INFRA_BLOCKED (§16.5).
 *   - Budget: MAX_RESOLVER_CALLS_PER_JOB (default 5) → RESOLUTION_EXHAUSTED (§16.6).
 */

import type { ControlSurface } from "./browser.js";
import { InfraBlockedError } from "../errors.js";
import { loadLimits } from "../policy/policy.js";

export type ComputerUseAction =
  | { type: "screenshot" }
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dx: number; dy: number }
  | { type: "done"; success: boolean; note?: string | undefined };

export interface ComputerUseOutcome {
  success: boolean;
  /** Model calls consumed. Counts against the per-job resolver budget. */
  steps: number;
  note?: string;
}

export interface ComputerUseRunOptions {
  /** Hard cap on model round-trips for this invocation. */
  maxSteps?: number;
}

export interface ComputerUseAgent {
  /**
   * Drive `surface` toward `instruction`. Returns when the goal is reached, the
   * agent gives up, or `maxSteps` is hit. Never used to confirm a purchase.
   */
  run(surface: ControlSurface, instruction: string, opts?: ComputerUseRunOptions): Promise<ComputerUseOutcome>;
}

async function applyAction(surface: ControlSurface, action: ComputerUseAction): Promise<void> {
  switch (action.type) {
    case "click":
      await surface.mouseClick(action.x, action.y);
      return;
    case "type":
      await surface.type(action.text);
      return;
    case "key":
      await surface.pressKey(action.key);
      return;
    case "scroll":
      await surface.scroll(action.dx, action.dy);
      return;
    case "screenshot":
    case "done":
      return;
  }
}

/** Deterministic agent that replays a fixed action list. For tests and demos. */
export class ScriptedComputerUseAgent implements ComputerUseAgent {
  constructor(private readonly script: ComputerUseAction[]) {}

  async run(surface: ControlSurface, _instruction: string, opts?: ComputerUseRunOptions): Promise<ComputerUseOutcome> {
    const maxSteps = opts?.maxSteps ?? Number.POSITIVE_INFINITY;
    let steps = 0;
    for (const action of this.script) {
      if (steps >= maxSteps) return { success: false, steps, note: "max steps reached" };
      steps += 1;
      if (action.type === "done") {
        return action.note === undefined
          ? { success: action.success, steps }
          : { success: action.success, steps, note: action.note };
      }
      await applyAction(surface, action);
    }
    return { success: true, steps };
  }
}

// ---------------------------------------------------------------------------
// OpenRouter resolver (the documented model layer, §16.3)
// ---------------------------------------------------------------------------

/** Minimal fetch shape so this stays dependency-free and mockable. */
export interface OpenRouterFetch {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export interface OpenRouterComputerUseOptions {
  /**
   * Defaults to process.env.OPENROUTER_INFRA_KEY. This is Aisle's resolver key —
   * NOT the demo vendor key (OPENROUTER_DEMO_KEY). Never recoverable.
   */
  apiKey?: string;
  /**
   * Must accept image input. Defaults to process.env.OPENROUTER_VISION_MODEL, then
   * NVIDIA Nemotron 3 Nano Omni (free). ⚠ VERIFY slugs against the live catalogue.
   */
  model?: string;
  /** OpenRouter `models` failover array, in priority order. Defaults to none. */
  fallbackModels?: string[];
  /** Per-invocation cap. Defaults to MAX_RESOLVER_CALLS_PER_JOB (5). */
  maxSteps?: number;
  /**
   * Token budget per call. Nemotron is a reasoning model, so reasoning tokens
   * count against this; too small and the reply comes back empty. Default 4096.
   */
  maxTokens?: number;
  baseUrl?: string;
  referer?: string;
  title?: string;
  /** Called after every model call with the model OpenRouter actually used (cost attribution). */
  onModelCall?: (info: { step: number; modelRequested: string; modelUsed: string | undefined }) => void;
  fetchImpl?: OpenRouterFetch;
  /** Abort a model call after this long. Free reasoning models can stall indefinitely. Default 60s. */
  requestTimeoutMs?: number;
}

/** Free-tier models can hold a request open for minutes; never wait longer than this. */
export const OPENROUTER_REQUEST_TIMEOUT_MS = 60_000;

/** §16.3 VISION profile. */
export const VISION_PROFILE = {
  model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  models: [] as readonly string[],
} as const;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const dataUrl = (bytes: Uint8Array): string => `data:image/png;base64,${b64(bytes)}`;

/** Parse a single action JSON object out of a model reply. Tolerates fences and prose. */
export function parseComputerUseAction(text: string): ComputerUseAction | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const num = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  switch (String(obj["action"] ?? "")) {
    case "click": {
      const x = num(obj["x"]);
      const y = num(obj["y"]);
      return x === undefined || y === undefined ? undefined : { type: "click", x, y };
    }
    case "type":
      return { type: "type", text: String(obj["text"] ?? "") };
    case "key":
      return { type: "key", key: String(obj["key"] ?? "") };
    case "scroll":
      return { type: "scroll", dx: num(obj["dx"]) ?? 0, dy: num(obj["dy"]) ?? 0 };
    case "done":
      return {
        type: "done",
        success: obj["success"] === true,
        note: obj["note"] === undefined ? undefined : String(obj["note"]),
      };
    default:
      return undefined;
  }
}

export function createOpenRouterComputerUseAgent(options: OpenRouterComputerUseOptions = {}): ComputerUseAgent {
  const apiKey = options.apiKey ?? process.env["OPENROUTER_INFRA_KEY"];
  if (!apiKey) {
    throw new Error("OPENROUTER_INFRA_KEY is required for createOpenRouterComputerUseAgent (Aisle's resolver key).");
  }
  const model = options.model ?? process.env["OPENROUTER_VISION_MODEL"] ?? VISION_PROFILE.model;
  const fallbackModels = options.fallbackModels ?? [...VISION_PROFILE.models];
  const maxTokens = options.maxTokens ?? 4096;
  const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  const defaultMaxSteps = options.maxSteps ?? loadLimits().maxResolverCallsPerJob;
  const doFetch: OpenRouterFetch = options.fetchImpl ?? (globalThis.fetch as unknown as OpenRouterFetch);

  const systemFor = (w: number, h: number): string =>
    `You control a web browser to accomplish a goal. Each screenshot is ${w}x${h} pixels; ` +
    `coordinates are absolute pixels from the top-left. Reply with EXACTLY ONE JSON object and ` +
    `nothing else, one of:\n` +
    `{"action":"click","x":<int>,"y":<int>}\n` +
    `{"action":"type","text":"..."}\n` +
    `{"action":"key","key":"Enter"}\n` +
    `{"action":"scroll","dx":0,"dy":300}\n` +
    `{"action":"done","success":true,"note":"..."}\n` +
    `NEVER confirm, submit, or pay for anything, and never enter payment details. ` +
    `Return done with success=true once the goal is reached, or success=false if you cannot proceed.`;

  return {
    async run(surface, instruction, runOpts) {
      const maxSteps = Math.min(runOpts?.maxSteps ?? defaultMaxSteps, defaultMaxSteps);
      const { width, height } = surface.viewport();

      const messages: Array<Record<string, unknown>> = [
        { role: "system", content: systemFor(width, height) },
        {
          role: "user",
          content: [
            { type: "text", text: `Goal: ${instruction}` },
            { type: "image_url", image_url: { url: dataUrl(await surface.screenshot()) } },
          ],
        },
      ];

      for (let step = 0; step < maxSteps; step++) {
        const payload: Record<string, unknown> = {
          model,
          max_tokens: maxTokens,
          // Keep reasoning out of `content` so the JSON action parses cleanly.
          reasoning: { exclude: true },
          messages,
        };
        if (fallbackModels.length > 0) payload["models"] = fallbackModels;

        let resp: { ok: boolean; status: number; text(): Promise<string> };
        try {
          resp = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": options.referer ?? "https://aisle.dev",
              "X-OpenRouter-Title": options.title ?? "Aisle",
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(options.requestTimeoutMs ?? OPENROUTER_REQUEST_TIMEOUT_MS),
          });
        } catch (err) {
          return { success: false, steps: step + 1, note: `OpenRouter request failed: ${String(err)}` };
        }
        // §16.5: the resolver's own credits are gone. Never a recovery job.
        if (resp.status === 402) throw new InfraBlockedError();
        if (!resp.ok) return { success: false, steps: step + 1, note: `OpenRouter HTTP ${resp.status}` };

        const parsed = parseOpenAiBody(await resp.text());
        options.onModelCall?.({ step: step + 1, modelRequested: model, modelUsed: parsed.model });
        const action = parsed.content === undefined ? undefined : parseComputerUseAction(parsed.content);
        messages.push({ role: "assistant", content: parsed.content ?? "" });

        if (!action) {
          messages.push({ role: "user", content: "Reply with only the JSON action object." });
          continue;
        }
        if (action.type === "done") {
          return action.note === undefined
            ? { success: action.success, steps: step + 1 }
            : { success: action.success, steps: step + 1, note: action.note };
        }
        await applyAction(surface, action);
        messages.push({
          role: "user",
          content: [
            { type: "text", text: "Result:" },
            { type: "image_url", image_url: { url: dataUrl(await surface.screenshot()) } },
          ],
        });
      }
      return { success: false, steps: maxSteps, note: "max steps reached" };
    },
  };
}

function parseOpenAiBody(body: string): { content: string | undefined; model: string | undefined } {
  try {
    const parsed = JSON.parse(body) as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.message?.content;
    return {
      content: typeof content === "string" ? content : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
    };
  } catch {
    return { content: undefined, model: undefined };
  }
}
