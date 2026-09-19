/**
 * The pitch + persona-distill layer for the Explore step. Turns ranked products into
 * one-line elevator pitches — each in its assigned tone (the A/B arm) — and distills a
 * user's freeform "about me" into coarse persona tags for ranking.
 *
 * Both use the shared OpenRouter infra (Qwen 3.7 Max) but ALWAYS have a deterministic
 * fallback, so Explore works offline / without a key and stays unit-testable.
 */

import type { OpenRouterFetch } from "../slow-lane/computer-use.js";
import { OPENROUTER_REQUEST_TIMEOUT_MS } from "../slow-lane/computer-use.js";
import { RECOMMEND_PROFILE } from "./recommend.js";
import type { PersonaProfile, RankedItem, Tone } from "./personalization.js";

export interface Pitched extends RankedItem {
  pitch: string;
}

const money = (minor?: number, currency?: string): string => {
  if (minor === undefined) return "";
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency ?? "USD" }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency ?? ""}`.trim();
  }
};

/** Templated pitch per tone — the fallback, and a floor on quality. */
function fallbackPitch(item: RankedItem): string {
  const title = item.product.title ?? "this pick";
  const price = money(item.product.price_minor, item.product.currency);
  const at = price ? ` (${price})` : "";
  const byTone: Record<Tone, string> = {
    value: `Smart value: ${title}${at} — quality without overpaying.`,
    aspirational: `Elevate your everyday with ${title}${at}.`,
    social_proof: `A crowd favourite — ${title}${at}, loved by many.`,
    expert: `Our considered pick: ${title}${at}, chosen for quality.`,
    playful: `Meet your new favourite: ${title}${at}. 🎉`,
  };
  return byTone[item.tone];
}

const TONE_GUIDE: Record<Tone, string> = {
  value: "practical, price-savvy, emphasise value",
  aspirational: "aspirational, lifestyle, paint the upgrade",
  social_proof: "social proof, popularity, others love it",
  expert: "expert, confident, quality-led",
  playful: "playful, warm, a little fun",
};

export interface PitchOptions {
  apiKey?: string;
  model?: string;
  fallbackModels?: string[];
  baseUrl?: string;
  fetchImpl?: OpenRouterFetch;
  requestTimeoutMs?: number;
  disableLlm?: boolean;
}

async function callOpenRouter(prompt: string, apiKey: string, options: PitchOptions): Promise<string | undefined> {
  const model = options.model ?? process.env["OPENROUTER_PITCH_MODEL"] ?? RECOMMEND_PROFILE.model;
  const fallbackModels = options.fallbackModels ?? [...RECOMMEND_PROFILE.models];
  const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  const doFetch: OpenRouterFetch = options.fetchImpl ?? (globalThis.fetch as unknown as OpenRouterFetch);
  const payload: Record<string, unknown> = { model, max_tokens: 700, reasoning: { exclude: true }, messages: [{ role: "user", content: prompt }] };
  if (fallbackModels.length > 0) payload["models"] = fallbackModels;
  const resp = await doFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://aisle.dev", "X-OpenRouter-Title": "Aisle" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(options.requestTimeoutMs ?? OPENROUTER_REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) return undefined;
  const body = JSON.parse(await resp.text()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const c = body.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : undefined;
}

function extractArray(text: string): unknown[] | undefined {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return undefined;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Attach a one-line pitch to each ranked product, in that product's assigned tone.
 * One OpenRouter call for the whole shortlist; any gap is filled from the template.
 */
export async function generatePitches(items: RankedItem[], profile: PersonaProfile, options: PitchOptions = {}): Promise<Pitched[]> {
  if (items.length === 0) return [];
  const apiKey = options.apiKey ?? process.env["OPENROUTER_INFRA_KEY"];
  const withFallback = (): Pitched[] => items.map((it) => ({ ...it, pitch: fallbackPitch(it) }));
  if (options.disableLlm || !apiKey) return withFallback();

  const persona = profile.consent && profile.tags.length > 0 ? ` The shopper is: ${profile.tags.join(", ")}.` : "";
  const lines = items
    .map((it, i) => `${i}. sku=${it.product.sku} | "${it.product.title ?? "item"}" ${money(it.product.price_minor, it.product.currency)} | tone: ${TONE_GUIDE[it.tone]}`)
    .join("\n");
  const prompt =
    `Write a ONE-sentence shopping pitch (max 18 words) for each product, in that product's tone.${persona}\n` +
    `Be truthful to the product; no fake claims, no emojis unless the tone is playful.\n${lines}\n\n` +
    `Return ONLY a minified JSON array: [{"i":0,"pitch":"..."}, ...] one per product, same order.`;

  try {
    const text = await callOpenRouter(prompt, apiKey, options);
    const arr = text ? extractArray(text) : undefined;
    if (!arr) return withFallback();
    const byIndex = new Map<number, string>();
    for (const e of arr) {
      if (typeof e !== "object" || e === null) continue;
      const o = e as Record<string, unknown>;
      const i = Number(o["i"]);
      const p = typeof o["pitch"] === "string" ? o["pitch"].trim() : "";
      if (Number.isInteger(i) && p) byIndex.set(i, p.slice(0, 160));
    }
    return items.map((it, i) => ({ ...it, pitch: byIndex.get(i) || fallbackPitch(it) }));
  } catch {
    return withFallback();
  }
}

/** Keyword fallback for persona distillation — no LLM needed. */
function fallbackTags(about: string): { tags: string[]; budgetBand?: PersonaProfile["budgetBand"] } {
  const t = about.toLowerCase();
  const tags: string[] = [];
  const add = (re: RegExp, tag: string) => { if (re.test(t)) tags.push(tag); };
  add(/student|uni|college|grad school/, "student");
  add(/budget|cheap|afford|frugal|save money|low.?cost/, "budget-conscious");
  add(/premium|luxury|high.?end|splurge/, "premium-seeker");
  add(/formal|business|office|professional|smart/, "smart-casual");
  add(/casual|streetwear|relaxed/, "casual");
  add(/minimal|simple|classic/, "minimalist");
  add(/tech|developer|gamer|gadget/, "tech");
  add(/eco|sustainab|ethical/, "eco-conscious");
  const budgetBand = /premium|luxury|high.?end|splurge/.test(t) ? "high" : /budget|cheap|afford|frugal|student/.test(t) ? "low" : undefined;
  return { tags: [...new Set(tags)], ...(budgetBand ? { budgetBand } : {}) };
}

/** Distill freeform "about me" into coarse persona tags (+ budget band). LLM with fallback. */
export async function distillPersona(about: string, options: PitchOptions = {}): Promise<{ tags: string[]; budgetBand?: PersonaProfile["budgetBand"] }> {
  const text = about.trim();
  if (!text) return { tags: [] };
  const apiKey = options.apiKey ?? process.env["OPENROUTER_INFRA_KEY"];
  if (options.disableLlm || !apiKey) return fallbackTags(text);

  const prompt =
    `Distill this shopper self-description into 2-6 short, generic persona tags for product ranking ` +
    `(e.g. "student", "budget-conscious", "smart-casual", "tech", "eco-conscious"). No names, no PII.\n` +
    `Description: ${text.slice(0, 400)}\n` +
    `Also give a budget band: "low" | "mid" | "high" | "".\n` +
    `Return ONLY minified JSON: {"tags":["",""],"budget":""}`;
  try {
    const raw = await callOpenRouter(prompt, apiKey, options);
    const start = raw?.indexOf("{") ?? -1;
    const end = raw?.lastIndexOf("}") ?? -1;
    if (!raw || start < 0 || end < start) return fallbackTags(text);
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const tags = Array.isArray(obj["tags"]) ? obj["tags"].filter((x): x is string => typeof x === "string").map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 6) : [];
    const b = typeof obj["budget"] === "string" ? obj["budget"].toLowerCase() : "";
    const budgetBand = b === "low" || b === "mid" || b === "high" ? (b as PersonaProfile["budgetBand"]) : undefined;
    if (tags.length === 0) return fallbackTags(text);
    return { tags, ...(budgetBand ? { budgetBand } : {}) };
  } catch {
    return fallbackTags(text);
  }
}
