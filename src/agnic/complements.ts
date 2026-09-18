/**
 * Complementary-product suggestions for the checkout moment — the "frequently bought
 * together" upsell (keyboard → mouse, blazer → dress shirt). Turns the item the user is
 * about to buy into a few complement search queries; the caller then searches Agnic and
 * ranks the results through the same personalization model.
 *
 * LLM (Qwen 3.7 Max) with a deterministic heuristic fallback, so it works offline.
 */

import type { OpenRouterFetch } from "../slow-lane/computer-use.js";
import { OPENROUTER_REQUEST_TIMEOUT_MS } from "../slow-lane/computer-use.js";
import { RECOMMEND_PROFILE } from "./recommend.js";

// Cheap, transparent complement map: matched against the item being bought.
const MAP: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/keyboard/i, ["mouse", "mouse pad", "wrist rest"]],
  [/\bmouse\b/i, ["mouse pad", "mechanical keyboard"]],
  [/laptop|macbook|notebook/i, ["laptop sleeve", "usb-c hub", "wireless mouse"]],
  [/monitor|display/i, ["monitor stand", "hdmi cable", "desk lamp"]],
  [/\bphone|iphone|android|pixel/i, ["phone case", "screen protector", "charger"]],
  [/camera/i, ["memory card", "camera bag", "tripod"]],
  [/blazer|suit\b/i, ["dress shirt", "tie", "leather shoes"]],
  [/\bshirt/i, ["tie", "cufflinks"]],
  [/shoes|sneaker/i, ["socks", "shoe care kit"]],
  [/\bdesk\b/i, ["desk lamp", "office chair", "cable organizer"]],
  [/chair/i, ["seat cushion", "footrest"]],
  [/coffee|espresso/i, ["coffee beans", "mug", "milk frother"]],
  [/tent|camping/i, ["sleeping bag", "camping stove"]],
  [/guitar/i, ["guitar strings", "capo", "tuner"]],
  [/bike|bicycle/i, ["helmet", "bike lock", "water bottle"]],
  [/yoga|mat\b/i, ["yoga block", "water bottle"]],
  [/backpack|bag\b/i, ["packing cubes", "water bottle"]],
];

export function heuristicComplements(seed: string): string[] {
  for (const [re, comps] of MAP) if (re.test(seed)) return [...comps];
  return [];
}

export interface ComplementOptions {
  apiKey?: string;
  model?: string;
  fallbackModels?: string[];
  baseUrl?: string;
  fetchImpl?: OpenRouterFetch;
  requestTimeoutMs?: number;
  disableLlm?: boolean;
  /** How many complement queries to return. Default 3. */
  max?: number;
}

/**
 * A few complement search queries for the item the user is buying. The LLM generalises
 * beyond the map (e.g. "espresso machine" → "descaling solution"); the map is the floor.
 */
export async function complementQueries(seed: string, options: ComplementOptions = {}): Promise<string[]> {
  const s = seed.trim();
  const max = options.max ?? 3;
  if (!s) return [];
  const heur = heuristicComplements(s).slice(0, max);
  const apiKey = options.apiKey ?? process.env["OPENROUTER_INFRA_KEY"];
  if (options.disableLlm || !apiKey) return heur;

  const model = options.model ?? process.env["OPENROUTER_PITCH_MODEL"] ?? RECOMMEND_PROFILE.model;
  const fallbackModels = options.fallbackModels ?? [...RECOMMEND_PROFILE.models];
  const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  const doFetch: OpenRouterFetch = options.fetchImpl ?? (globalThis.fetch as unknown as OpenRouterFetch);
  const prompt =
    `A shopper is buying: "${s}". List ${max} DIFFERENT complementary products that pair well with it ` +
    `(accessories or natural add-ons a store would suggest at checkout), as short search queries. ` +
    `Not the same item, not substitutes. Return ONLY a minified JSON array of strings.`;
  const payload: Record<string, unknown> = { model, max_tokens: 200, reasoning: { exclude: true }, messages: [{ role: "user", content: prompt }] };
  if (fallbackModels.length > 0) payload["models"] = fallbackModels;

  try {
    const resp = await doFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://aisle.dev", "X-OpenRouter-Title": "Aisle" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? OPENROUTER_REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) return heur;
    const body = JSON.parse(await resp.text()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") return heur;
    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start < 0 || end < start) return heur;
    const arr = JSON.parse(content.slice(start, end + 1)) as unknown[];
    const qs = arr.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, max);
    return qs.length > 0 ? qs : heur;
  } catch {
    return heur;
  }
}
