/**
 * Computer-use fallback.
 *
 * The deterministic adapter path handles the common case. When a vendor's page
 * changes shape and a scripted step fails, the worker hands the stuck sub-goal
 * to a `ComputerUseAgent`, which drives the browser by screenshots + pixel input
 * via the `ControlSurface`.
 *
 * Per the chosen design, the MODEL is host-injected: the host coding agent
 * (Claude / Hermes / Codex) supplies the loop, exactly as it supplies the
 * WebMCP session for the fast lane. We ship:
 *   - the `ComputerUseAgent` interface,
 *   - a `ScriptedComputerUseAgent` for deterministic tests, and
 *   - `createAnthropicComputerUseAgent(...)` — a reference loop driven by an
 *     injected Anthropic-SDK client (no hard dependency on the SDK).
 */

import type { ControlSurface } from "./browser.js";

export type ComputerUseAction =
  | { type: "screenshot" }
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dx: number; dy: number }
  | { type: "done"; success: boolean; note?: string };

export interface ComputerUseOutcome {
  success: boolean;
  steps: number;
  note?: string;
}

export interface ComputerUseRunOptions {
  /** Hard cap on model/tool round-trips. */
  maxSteps?: number;
}

export interface ComputerUseAgent {
  /**
   * Drive `surface` toward `instruction`. Returns when the goal is reached, the
   * agent gives up, or `maxSteps` is hit. The agent NEVER confirms a purchase on
   * its own — the worker gates confirmation behind the mandate.
   */
  run(
    surface: ControlSurface,
    instruction: string,
    opts?: ComputerUseRunOptions,
  ): Promise<ComputerUseOutcome>;
}

/** Apply a single action to the control surface. */
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

/**
 * Deterministic agent that replays a fixed action list. For tests and for
 * demonstrating the fallback path without a real model.
 */
export class ScriptedComputerUseAgent implements ComputerUseAgent {
  constructor(private readonly script: ComputerUseAction[]) {}

  async run(surface: ControlSurface, _instruction: string): Promise<ComputerUseOutcome> {
    let steps = 0;
    for (const action of this.script) {
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
// Anthropic reference implementation (optional; client is injected)
// ---------------------------------------------------------------------------

/** Minimal structural type for the injected Anthropic SDK client. */
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
  maxSteps?: number;
  /** Anthropic computer-use tool version, e.g. "computer_20250124". */
  toolType?: string;
  betaFlag?: string;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/**
 * Reference computer-use loop over an injected Anthropic client. The host owns
 * the model/credentials; this function just wires screenshots ⇄ tool calls ⇄
 * the control surface. Kept intentionally small; harden before production use.
 */
export function createAnthropicComputerUseAgent(
  client: AnthropicLike,
  options: AnthropicComputerUseOptions = {},
): ComputerUseAgent {
  const model = options.model ?? "claude-sonnet-5";
  const toolType = options.toolType ?? "computer_20250124";
  const betaFlag = options.betaFlag ?? "computer-use-2025-01-24";
  const defaultMaxSteps = options.maxSteps ?? 15;

  return {
    async run(surface, instruction, runOpts) {
      const maxSteps = runOpts?.maxSteps ?? defaultMaxSteps;
      const { width, height } = surface.viewport();

      const tools = [
        { type: toolType, name: "computer", display_width_px: width, display_height_px: height },
      ];

      // Seed with the instruction + an initial screenshot.
      const messages: Array<Record<string, unknown>> = [
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: b64(await surface.screenshot()) },
            },
          ],
        },
      ];

      for (let step = 0; step < maxSteps; step++) {
        const resp = await client.beta.messages.create({
          model,
          max_tokens: 1024,
          tools,
          betas: [betaFlag],
          messages,
        });

        messages.push({ role: "assistant", content: resp.content });

        const toolUses = resp.content.filter((c) => c["type"] === "tool_use");
        if (toolUses.length === 0 || resp.stop_reason === "end_turn") {
          return { success: true, steps: step + 1 };
        }

        const toolResults: Array<Record<string, unknown>> = [];
        for (const tu of toolUses) {
          const input = (tu["input"] ?? {}) as Record<string, unknown>;
          await applyAction(surface, mapAnthropicAction(input));
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu["id"],
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: b64(await surface.screenshot()),
                },
              },
            ],
          });
        }
        messages.push({ role: "user", content: toolResults });
      }

      return { success: false, steps: maxSteps, note: "max steps reached" };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenRouter reference implementation (OpenAI-compatible vision + JSON actions)
// ---------------------------------------------------------------------------

/**
 * Minimal fetch shape so this stays dependency-free and easily mockable in tests.
 */
export interface OpenRouterFetch {
  (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export interface OpenRouterComputerUseOptions {
  /** Defaults to process.env.OPENROUTER_API_KEY. */
  apiKey?: string;
  /**
   * OpenRouter model id. Must be a VISION model (it's fed screenshots). Free
   * vision models exist but are weak at pixel-precise clicking — pick a current
   * one from https://openrouter.ai/models?modality=text%2Bimage&max_price=0.
   */
  model?: string;
  maxSteps?: number;
  baseUrl?: string;
  /** OpenRouter attribution headers (optional but recommended). */
  referer?: string;
  title?: string;
  /** Injectable fetch for testing; defaults to global fetch. */
  fetchImpl?: OpenRouterFetch;
}

const DEFAULT_OPENROUTER_MODEL = "meta-llama/llama-3.2-11b-vision-instruct:free";

const dataUrl = (bytes: Uint8Array): string => `data:image/png;base64,${b64(bytes)}`;

/**
 * Parse a single action JSON object out of a model reply. Tolerates code fences
 * and surrounding prose. Exported for testing.
 */
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
  const action = String(obj["action"] ?? "");
  switch (action) {
    case "click":
      return { type: "click", x: Number(obj["x"] ?? 0), y: Number(obj["y"] ?? 0) };
    case "type":
      return { type: "type", text: String(obj["text"] ?? "") };
    case "key":
      return { type: "key", key: String(obj["key"] ?? "") };
    case "scroll":
      return { type: "scroll", dx: Number(obj["dx"] ?? 0), dy: Number(obj["dy"] ?? 0) };
    case "done":
      return {
        type: "done",
        success: Boolean(obj["success"]),
        note: obj["note"] === undefined ? undefined : String(obj["note"]),
      };
    default:
      return undefined;
  }
}

/**
 * Reference computer-use loop over OpenRouter (OpenAI-compatible). The model is
 * shown a screenshot and must reply with exactly one JSON action; we execute it
 * on the ControlSurface and feed back the next screenshot. Note: OpenRouter does
 * NOT expose Anthropic's computer-use tool, so this uses a plain vision + JSON
 * protocol — accuracy depends heavily on the chosen model.
 */
export function createOpenRouterComputerUseAgent(
  options: OpenRouterComputerUseOptions = {},
): ComputerUseAgent {
  const apiKey = options.apiKey ?? process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for createOpenRouterComputerUseAgent.");
  }
  const model = options.model ?? DEFAULT_OPENROUTER_MODEL;
  const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  const defaultMaxSteps = options.maxSteps ?? 15;
  const doFetch: OpenRouterFetch =
    options.fetchImpl ?? (globalThis.fetch as unknown as OpenRouterFetch);

  const systemFor = (w: number, h: number): string =>
    `You control a web browser to accomplish a goal. Each screenshot is ${w}x${h} pixels; ` +
    `coordinates are absolute pixels from the top-left. Reply with EXACTLY ONE JSON object and ` +
    `nothing else, one of:\n` +
    `{"action":"click","x":<int>,"y":<int>}\n` +
    `{"action":"type","text":"..."}\n` +
    `{"action":"key","key":"Enter"}\n` +
    `{"action":"scroll","dx":0,"dy":300}\n` +
    `{"action":"done","success":true,"note":"..."}\n` +
    `Do NOT confirm or submit any payment. Return done with success=true once the goal is reached, ` +
    `or success=false if you cannot proceed.`;

  return {
    async run(surface, instruction, runOpts) {
      const maxSteps = runOpts?.maxSteps ?? defaultMaxSteps;
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
        try {
          const resp = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": options.referer ?? "https://github.com/NoelVFX/Top-up-agent",
              "X-Title": options.title ?? "top-up-agent",
            },
            body: JSON.stringify({ model, max_tokens: 300, messages }),
          });
          if (!resp.ok) {
            return { success: false, steps: step + 1, note: `OpenRouter HTTP ${resp.status}` };
          }
          body = await resp.text();
        } catch (err) {
          return { success: false, steps: step + 1, note: `OpenRouter request failed: ${String(err)}` };
        }

        const content = extractOpenAiContent(body);
        const action = content === undefined ? undefined : parseComputerUseAction(content);
        messages.push({ role: "assistant", content: content ?? "" });

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

/** Pull choices[0].message.content out of an OpenAI-compatible JSON body. */
function extractOpenAiContent(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : undefined;
  } catch {
    return undefined;
  }
}

/** Translate Anthropic computer-tool input into our action union. */
function mapAnthropicAction(input: Record<string, unknown>): ComputerUseAction {
  const action = String(input["action"] ?? "");
  const coord = Array.isArray(input["coordinate"]) ? (input["coordinate"] as number[]) : undefined;
  switch (action) {
    case "left_click":
    case "mouse_click":
      return { type: "click", x: coord?.[0] ?? 0, y: coord?.[1] ?? 0 };
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
