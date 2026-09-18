/**
 * The routing brain: is this purchase a PHYSICAL good (Agnic's Shopify rail) or a
 * DIGITAL SaaS/plan/credits (Aisle's own browser checkout)? One entry classifies the
 * natural-language ask so the user never has to say which track they mean.
 *
 * Heuristic-first (free, instant) for the obvious cases; a cheap OpenRouter call
 * (Qwen 3.7 Max, same infra as recommend.ts) only when the keywords are ambiguous.
 * When no key/model is available it degrades to a keyword lean, never throwing.
 */

import type { OpenRouterFetch } from "../slow-lane/computer-use.js";
import { OPENROUTER_REQUEST_TIMEOUT_MS } from "../slow-lane/computer-use.js";
import { RECOMMEND_PROFILE } from "./recommend.js";

export type Track = "physical" | "saas";

export interface TrackClassification {
  track: Track;
  /** 0–1; heuristic hits are ~0.8, a bare default is ~0.4. */
  confidence: number;
  reason: string;
  source: "heuristic" | "llm" | "default";
}

// Digital: software, APIs, MCP tools, subscriptions, credits/top-ups.
const SAAS = /\b(subscriptions?|subscribe|plans?|pricing|credits?|top[-\s]?up|api|api[-\s]?key|saas|mcp|seats?|licen[sc]e|tiers?|per[-\s]?(?:month|seat|user)|\/mo|monthly|annual|billing|usage|compute|gpu|cloud|hosting|domains?|webhooks?|workspace|premium|starter|integration)\b/i;
// Physical: shipped goods.
const PHYSICAL = /\b(ship|shipping|shipped|deliver|delivery|address|sizes?|colou?rs?|fits?|wear|worn|headphones?|earbuds?|camera|lamp|mug|shirt|hoodie|bottle|charm|fidget|poster|books?|hardware|gadget|kit|merch|stickers?|cable|keyboard|mouse|desk|chair|shoes?|bag)\b/i;

const PROMPT = (t: string): string =>
  `Classify what the user wants to BUY into exactly one track:\n` +
  `- "physical": a tangible product shipped to an address (electronics, apparel, gear, homeware).\n` +
  `- "saas": a digital software product, API, MCP tool/server, subscription plan, or credits/top-up.\n` +
  `Request: ${t}\n` +
  `Return ONLY minified JSON: {"track":"physical|saas","confidence":0-1,"reason":"<=10 words"}`;

export interface ClassifyOptions {
  apiKey?: string;
  model?: string;
  fallbackModels?: string[];
  baseUrl?: string;
  fetchImpl?: OpenRouterFetch;
  requestTimeoutMs?: number;
  /** Skip the LLM entirely (tests / offline) — ambiguous asks then use the keyword lean. */
  disableLlm?: boolean;
}

/** Classify a purchase ask into the physical or SaaS track. Never throws. */
export async function classifyTrack(request: string, options: ClassifyOptions = {}): Promise<TrackClassification> {
  const t = request.trim();
  const s = SAAS.test(t);
  const p = PHYSICAL.test(t);
  if (s && !p) return { track: "saas", confidence: 0.8, reason: "digital keywords", source: "heuristic" };
  if (p && !s) return { track: "physical", confidence: 0.8, reason: "physical keywords", source: "heuristic" };

  const apiKey = options.apiKey ?? process.env["OPENROUTER_INFRA_KEY"];
  if (!options.disableLlm && apiKey && t) {
    const llm = await classifyWithLlm(t, apiKey, options).catch(() => undefined);
    if (llm) return llm;
  }

  // No decisive keyword and no usable model: a URL leans digital, otherwise assume a
  // shoppable product (the Agnic happy path). Low confidence, and honest about it.
  if (/\bhttps?:\/\//i.test(t)) return { track: "saas", confidence: 0.4, reason: "a checkout URL, no clear signal", source: "default" };
  const lean: Track = s && p ? "saas" : "physical"; // both matched ⇒ favour the plan/credits reading
  return { track: lean, confidence: 0.4, reason: s && p ? "mixed signals, favoured digital" : "no clear signal, defaulted to product", source: "default" };
}

async function classifyWithLlm(t: string, apiKey: string, options: ClassifyOptions): Promise<TrackClassification | undefined> {
  const model = options.model ?? process.env["OPENROUTER_CLASSIFY_MODEL"] ?? RECOMMEND_PROFILE.model;
  const fallbackModels = options.fallbackModels ?? [...RECOMMEND_PROFILE.models];
  const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  const doFetch: OpenRouterFetch = options.fetchImpl ?? (globalThis.fetch as unknown as OpenRouterFetch);
  const payload: Record<string, unknown> = {
    model,
    max_tokens: 200,
    reasoning: { exclude: true },
    messages: [{ role: "user", content: PROMPT(t) }],
  };
  if (fallbackModels.length > 0) payload["models"] = fallbackModels;

  const resp = await doFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://aisle.dev", "X-OpenRouter-Title": "Aisle" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(options.requestTimeoutMs ?? OPENROUTER_REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) return undefined;
  const body = JSON.parse(await resp.text()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") return undefined;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  const obj = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
  const track: Track = obj["track"] === "saas" ? "saas" : "physical";
  const confidence = typeof obj["confidence"] === "number" ? Math.max(0, Math.min(1, obj["confidence"])) : 0.7;
  return { track, confidence, reason: (typeof obj["reason"] === "string" ? obj["reason"] : "model").slice(0, 60), source: "llm" };
}
