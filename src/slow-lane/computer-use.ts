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
