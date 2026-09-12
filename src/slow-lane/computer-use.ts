/**
 * Computer-use resolver (aisle-pipeline.md §16, §17).
 *
 * The deterministic adapter path handles the common case. When a READ or
 * STAGING step can't complete, the worker hands the stuck sub-goal to a
 * `ComputerUseAgent`, which drives the browser by screenshots + pixel input.
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

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

// ---------------------------------------------------------------------------
// OpenRouter resolver (the documented model layer, §16.3)
// ---------------------------------------------------------------------------

/** Minimal fetch shape so this stays dependency-free and mockable. */
export interface OpenRouterFetch {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export interface OpenRouterComputerUseOptions {
  /**
   * Defaults to process.env.OPENROUTER_INFRA_KEY. This is Aisle's resolver key —
   * NOT the demo vendor key (OPENROUTER_DEMO_KEY). Never recoverable.
   */
  apiKey?: string;
  /** Primary model. Defaults to the VISION profile's `anthropic/claude-sonnet-4.6`. ⚠ VERIFY slugs. */
  model?: string;
  /** OpenRouter `models` failover array, in priority order. Defaults to `["openai/gpt-5"]`. */
  fallbackModels?: string[];
  /** Per-invocation cap. Defaults to MAX_RESOLVER_CALLS_PER_JOB (5). */
  maxSteps?: number;
  baseUrl?: string;
  referer?: string;
  title?: string;
  /** Called after every model call with the model OpenRouter actually used (cost attribution). */
  onModelCall?: (info: { step: number; modelRequested: string; modelUsed: string | undefined }) => void;
  fetchImpl?: OpenRouterFetch;
}

/** §16.3 VISION profile. */
export const VISION_PROFILE = { model: "anthropic/claude-sonnet-4.6", models: ["openai/gpt-5"] } as const;

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
  const model = options.model ?? VISION_PROFILE.model;
  const fallbackModels = options.fallbackModels ?? [...VISION_PROFILE.models];
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
        let body: string;
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
            body: JSON.stringify({ model, models: fallbackModels, max_tokens: 300, messages }),
          });
        } catch (err) {
          return { success: false, steps: step + 1, note: `OpenRouter request failed: ${String(err)}` };
        }
        // §16.5: the resolver's own credits are gone. Never a recovery job.
        if (resp.status === 402) throw new InfraBlockedError();
        if (!resp.ok) return { success: false, steps: step + 1, note: `OpenRouter HTTP ${resp.status}` };
        body = await resp.text();

        const parsed = parseOpenAiBody(body);
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

// ---------------------------------------------------------------------------
// Anthropic reference implementation (optional; client is injected)
// ---------------------------------------------------------------------------

export interface AnthropicLike {
  beta: {
    messages: {
      create(params: Record<string, unknown>): Promise<{
        content: Array<Record<string, unknown>>;
        stop_reason?: string;
      }>;
    };
  };
}

export interface AnthropicComputerUseOptions {
  model?: string;
  /** Defaults to MAX_RESOLVER_CALLS_PER_JOB (5). */
  maxSteps?: number;
  toolType?: string;
  betaFlag?: string;
}

/**
 * Reference computer-use loop over an injected Anthropic client. The documented
 * resolver is OpenRouter (§16); this exists for hosts that already hold an
 * Anthropic client. Same budget and same never-submit rule apply.
 */
export function createAnthropicComputerUseAgent(
  client: AnthropicLike,
  options: AnthropicComputerUseOptions = {},
): ComputerUseAgent {
  const model = options.model ?? "claude-sonnet-5";
  const toolType = options.toolType ?? "computer_20250124";
  const betaFlag = options.betaFlag ?? "computer-use-2025-01-24";
  const defaultMaxSteps = options.maxSteps ?? loadLimits().maxResolverCallsPerJob;

  return {
    async run(surface, instruction, runOpts) {
      const maxSteps = Math.min(runOpts?.maxSteps ?? defaultMaxSteps, defaultMaxSteps);
      const { width, height } = surface.viewport();
      const tools = [{ type: toolType, name: "computer", display_width_px: width, display_height_px: height }];

      const messages: Array<Record<string, unknown>> = [
        {
          role: "user",
          content: [
            { type: "text", text: `${instruction}\nNever confirm, submit, or pay for anything.` },
            { type: "image", source: { type: "base64", media_type: "image/png", data: b64(await surface.screenshot()) } },
          ],
        },
      ];

      for (let step = 0; step < maxSteps; step++) {
        const resp = await client.beta.messages.create({ model, max_tokens: 1024, tools, betas: [betaFlag], messages });
        messages.push({ role: "assistant", content: resp.content });

        const toolUses = resp.content.filter((c) => c["type"] === "tool_use");
        if (toolUses.length === 0 || resp.stop_reason === "end_turn") {
          return { success: true, steps: step + 1 };
        }

        const toolResults: Array<Record<string, unknown>> = [];
        for (const tu of toolUses) {
          await applyAction(surface, mapAnthropicAction((tu["input"] ?? {}) as Record<string, unknown>));
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu["id"],
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: b64(await surface.screenshot()) } },
            ],
          });
        }
        messages.push({ role: "user", content: toolResults });
      }
      return { success: false, steps: maxSteps, note: "max steps reached" };
    },
  };
}

function mapAnthropicAction(input: Record<string, unknown>): ComputerUseAction {
  const action = String(input["action"] ?? "");
  const coord = Array.isArray(input["coordinate"]) ? (input["coordinate"] as number[]) : undefined;
  switch (action) {
    case "left_click":
    case "mouse_click":
      return coord?.[0] === undefined || coord[1] === undefined ? { type: "screenshot" } : { type: "click", x: coord[0], y: coord[1] };
    case "type":
      return { type: "type", text: String(input["text"] ?? "") };
    case "key":
      return { type: "key", key: String(input["text"] ?? "") };
    case "scroll": {
      const dir = String(input["scroll_direction"] ?? "down");
      const amount = Number(input["scroll_amount"] ?? 3) * 100;
      return { type: "scroll", dx: 0, dy: dir === "up" ? -amount : amount };
    }
    default:
      return { type: "screenshot" };
  }
}
