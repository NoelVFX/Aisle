import type { Product, Tone } from "./types";
import { money } from "./demoData";

/**
 * Adds the multi-versioned tone + pitch to REAL Agnic products. The product data
 * (title, price, image, sku, merchant) is never touched. Only the pitch is invented,
 * by the OpenRouter LLM, and it is instructed not to claim specs the product name
 * doesn't state. Falls back to generic, spec-free tone lines with no LLM key.
 */

const TONES: Tone[] = ["value", "aspirational", "social_proof", "expert", "playful"];
const TONE_GUIDE: Record<Tone, string> = {
  value: "practical, price-savvy",
  aspirational: "aspirational, lifestyle",
  social_proof: "social proof, popular",
  expert: "expert, quality-led",
  playful: "playful, warm",
};
const FALLBACK: Record<Tone, string> = {
  value: "Priced to make this an easy yes.",
  aspirational: "The upgrade you will notice every day.",
  social_proof: "A popular pick with shoppers like you.",
  expert: "Our considered pick from this search.",
  playful: "Say hello to a new favourite.",
};

function rankForProfile(products: Product[], tags: string[]): Product[] {
  if (!tags.length) return products;
  return [...products].sort((a, b) => b.attrs.filter((x) => tags.includes(x)).length - a.attrs.filter((x) => tags.includes(x)).length);
}

async function llmPitches(items: Product[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const key = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_INFRA_KEY;
  if (!key) return out;
  const model = process.env.AISLE_CHAT_MODEL || "deepseek/deepseek-chat-v3.1";
  const lines = items.map((p, i) => `${i}. "${p.title}" (${money(p.priceMinor, p.currency)}) tone: ${TONE_GUIDE[p.tone]}`).join("\n");
  const prompt =
    `Write a ONE-sentence shopping pitch (max 16 words) for each product below, in its given tone.\n` +
    `Use ONLY the product's name. Do NOT invent specs, materials, features, or prices not in the name. No em dashes, no emojis.\n${lines}\n\n` +
    `Return ONLY a minified JSON array: [{"i":0,"pitch":"..."}], one per product, same order.`;
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://aisle.dev", "X-Title": "Aisle" },
      body: JSON.stringify({ model, max_tokens: 500, temperature: 0.6, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return out;
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const c = data.choices?.[0]?.message?.content;
    if (typeof c !== "string") return out;
    const s = c.indexOf("["), e = c.lastIndexOf("]");
    if (s < 0 || e < s) return out;
    const arr = JSON.parse(c.slice(s, e + 1)) as unknown[];
    for (const el of arr) {
      if (el && typeof el === "object") {
        const o = el as Record<string, unknown>;
        const i = Number(o["i"]);
        const pitch = typeof o["pitch"] === "string" ? o["pitch"].trim().replace(/\s*[—–]\s*/g, ", ") : "";
        if (Number.isInteger(i) && pitch) out.set(i, pitch.slice(0, 140));
      }
    }
  } catch {
    /* fall through to templates */
  }
  return out;
}

/** Rank real products for the profile, assign a distinct tone to each, and pitch them. */
export async function pitchProducts(products: Product[], profileTags: string[] = []): Promise<Product[]> {
  const ranked = rankForProfile(products, profileTags).map((p, i) => ({ ...p, tone: TONES[i % TONES.length]! }));
  const pitches = await llmPitches(ranked);
  return ranked.map((p, i) => ({ ...p, pitch: pitches.get(i) || FALLBACK[p.tone] }));
}
