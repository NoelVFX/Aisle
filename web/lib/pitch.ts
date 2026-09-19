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
  const men = tags.some((x) => ["mens", "man", "male", "menswear", "men"].includes(x));
  const women = tags.some((x) => ["womens", "woman", "female", "womenswear", "women"].includes(x));
  const score = (p: Product) => {
    let s = p.attrs.filter((x) => tags.includes(x)).length;
    const t = p.title.toLowerCase();
    if (men) { if (/\b(women|woman|ladies|female|her)\b/.test(t)) s -= 4; if (/\b(men|man|male|guys?)\b/.test(t)) s += 2; }
    if (women) { if (/\b(men|man|male|guys?)\b/.test(t)) s -= 4; if (/\b(women|woman|ladies|female)\b/.test(t)) s += 2; }
    return s;
  };
  return [...products].sort((a, b) => score(b) - score(a));
}

/** A short persona descriptor from the saved profile (freeform context first, then tags). */
function personaDescriptor(tags: string[], context: string): string {
  const ctx = context.trim().slice(0, 160);
  const t = tags.filter((x) => !["man", "woman", "male", "female"].includes(x)).join(", ");
  if (ctx && t) return `${ctx} (${t})`;
  return ctx || t;
}

async function llmPitches(items: Product[], persona: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const key = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_INFRA_KEY;
  if (!key) return out;
  const model = process.env.AISLE_CHAT_MODEL || "deepseek/deepseek-chat-v3.1";
  const lines = items.map((p, i) => `${i}. "${p.title}" (${money(p.priceMinor, p.currency)}) tone: ${TONE_GUIDE[p.tone]}`).join("\n");
  const personaLine = persona
    ? `The shopper is: ${persona}. In roughly half the pitches, weave ONE short phrase that speaks to who they are (their role, life stage, or taste), e.g. "great for a sophomore juggling classes". Keep it natural, do not force it into every line.\n`
    : "";
  const prompt =
    `Write a ONE-sentence shopping pitch (max 18 words) for each product below, in its given tone.\n` +
    personaLine +
    `Use ONLY the product's name for facts. Do NOT invent specs, materials, features, or prices not in the name. No em dashes, no emojis.\n${lines}\n\n` +
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

/** Rank real products for the profile, assign a distinct tone to each, and pitch them
 *  (pitches are tailored to the persona when a profile is present). */
export async function pitchProducts(products: Product[], profileTags: string[] = [], profileContext = ""): Promise<Product[]> {
  const ranked = rankForProfile(products, profileTags).map((p, i) => ({ ...p, tone: TONES[i % TONES.length]! }));
  const pitches = await llmPitches(ranked, personaDescriptor(profileTags, profileContext));
  return ranked.map((p, i) => ({ ...p, pitch: pitches.get(i) || FALLBACK[p.tone] }));
}
