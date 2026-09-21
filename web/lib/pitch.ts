import type { Product, Tone } from "./types";
import { money } from "./demoData";
import { colorFromTags, colorMatches, COLOR_NAMES } from "./colors";

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

// "student" is a LIFE STAGE, not a budget signal, so it never forces cheap ranking.
const GENDER_TAGS = ["mens", "man", "male", "menswear", "men", "womens", "woman", "female", "womenswear", "women"];
const BUDGET_TAGS = ["budget-conscious", "budget", "value-seeker", "cheap", "frugal"];
const PREMIUM_TAGS = ["premium-seeker", "premium", "luxury", "splurge", "high-end"];

type Prefs = { men: boolean; women: boolean; budget: boolean; premium: boolean };
function readPrefs(tags: string[]): Prefs {
  const has = (list: string[]) => tags.some((x) => list.includes(x));
  const budget = has(BUDGET_TAGS);
  const premium = has(PREMIUM_TAGS);
  return {
    men: tags.some((x) => ["mens", "man", "male", "menswear", "men"].includes(x)),
    women: tags.some((x) => ["womens", "woman", "female", "womenswear", "women"].includes(x)),
    // If both are somehow set, treat as neutral so we don't contradict ourselves.
    budget: budget && !premium,
    premium: premium && !budget,
  };
}

/** Rank for the profile: gender-correct first, then the budget/premium price direction, with the
 *  favorite color and attribute overlap suiting each item. When no budget stance is set, the
 *  favorite color leads; when it is, price still dominates and color breaks ties, so a budget
 *  shopper keeps cheapest-first while the shortlist still leans to their color (also via search). */
function rankForProfile(products: Product[], tags: string[]): Product[] {
  if (!tags.length) return products;
  const { men, women, budget, premium } = readPrefs(tags);
  const color = colorFromTags(tags);
  const gender = (p: Product) => {
    const t = p.title.toLowerCase();
    if (men) { if (/\b(women|woman|ladies|female|her)\b/.test(t)) return -1; if (/\b(men|man|male|guys?)\b/.test(t)) return 1; }
    if (women) { if (/\b(men|man|male|guys?)\b/.test(t)) return -1; if (/\b(women|woman|ladies|female)\b/.test(t)) return 1; }
    return 0;
  };
  const attr = (p: Product) => p.attrs.filter((x) => tags.includes(x)).length;
  const colorFit = (p: Product) => (color && (colorMatches(p.title, color) || p.attrs.some((a) => colorMatches(a, color))) ? 1 : 0);
  return [...products].sort((a, b) => {
    const g = gender(b) - gender(a);
    if (g) return g; // 1. correct-gender items first
    // No budget stance: the favorite color leads the order.
    if (color && !budget && !premium) { const c = colorFit(b) - colorFit(a); if (c) return c; }
    if ((budget || premium) && a.priceMinor > 0 && b.priceMinor > 0 && a.priceMinor !== b.priceMinor) {
      return budget ? a.priceMinor - b.priceMinor : b.priceMinor - a.priceMinor; // 2. price direction dominates
    }
    const c = colorFit(b) - colorFit(a); // 3. favorite-color match (tiebreak after price)
    if (c) return c;
    return attr(b) - attr(a); // 4. attribute overlap
  });
}

/** Tone order tuned to the budget preference: premium never gets a "value" label, and a
 *  budget shopper never gets an "aspirational" one, so the chip matches what they asked for. */
function tonesFor({ budget, premium }: Prefs): Tone[] {
  if (premium) return ["aspirational", "expert", "social_proof", "playful"];
  if (budget) return ["value", "social_proof", "playful", "expert"];
  return TONES;
}

/** One firm instruction so pitch copy never contradicts the shopper's budget stance. */
function budgetStance({ budget, premium }: Prefs): string {
  if (premium) return "This shopper prefers premium, high-end choices. Frame every pitch around quality, craftsmanship, design or elevated style. Never call anything cheap, budget, affordable, great-value, or say it is for someone on a budget.";
  if (budget) return "This shopper is budget-conscious and wants value for money. Frame pitches around smart value and practicality. Never call anything premium, luxury, high-end or a splurge.";
  return "";
}

/** A short persona descriptor from the saved profile (freeform context first, then tags).
 *  Excludes gender and budget/premium tags, which are handled by ranking and the budget stance. */
function personaDescriptor(tags: string[], context: string): string {
  const ctx = context.trim().slice(0, 160);
  const drop = new Set([...GENDER_TAGS, ...BUDGET_TAGS, ...PREMIUM_TAGS, ...COLOR_NAMES]);
  const t = tags.filter((x) => !drop.has(x)).join(", ");
  if (ctx && t) return `${ctx} (${t})`;
  return ctx || t;
}

async function llmPitches(items: Product[], persona: string, stance: string, colorPref = ""): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const key = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_INFRA_KEY;
  if (!key) return out;
  const model = process.env.AISLE_CHAT_MODEL || "deepseek/deepseek-chat-v3.1";
  const lines = items.map((p, i) => `${i}. "${p.title}" (${money(p.priceMinor, p.currency)}) tone: ${TONE_GUIDE[p.tone]}`).join("\n");
  const stanceLine = stance ? `${stance}\n` : "";
  const colorLine = colorPref
    ? `The shopper's favorite color is ${colorPref}. When a product's name shows it is ${colorPref} (or a shade of it), note that it matches their color. NEVER claim a color the product name does not state.\n`
    : "";
  const personaLine = persona
    ? `The shopper is: ${persona}. In roughly half the pitches, weave ONE short phrase that speaks to who they are (their role, life stage, or taste), e.g. "great for a sophomore juggling classes". Keep it natural, do not force it into every line, and never let it contradict the guidance above.\n`
    : "";
  const prompt =
    `Write a ONE-sentence shopping pitch (max 18 words) for each product below, in its given tone.\n` +
    stanceLine +
    colorLine +
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
  const prefs = readPrefs(profileTags);
  const tones = tonesFor(prefs);
  const ranked = rankForProfile(products, profileTags).map((p, i) => ({ ...p, tone: tones[i % tones.length]! }));
  const pitches = await llmPitches(ranked, personaDescriptor(profileTags, profileContext), budgetStance(prefs), colorFromTags(profileTags) ?? "");
  return ranked.map((p, i) => ({ ...p, pitch: pitches.get(i) || FALLBACK[p.tone] }));
}
