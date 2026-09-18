/**
 * The Preference Model behind the Shopify track's Explore step — the part Agnic
 * doesn't own. One local, per-user model (this gateway is single-user) that:
 *   - remembers a CONSENTED persona (tags, budget band) and past choices,
 *   - ranks Agnic's flat product list by persona + what has actually converted,
 *   - assigns each shown product a DIFFERENT pitch tone (an A/B arm) via an
 *     epsilon-greedy bandit, and learns from which one the user proceeds to buy.
 *
 * Privacy: everything lives in .aisle/personalization.json, never leaves the box,
 * and nothing is stored until `consent` is set. The pitch/LLM layer sees product
 * data + coarse persona tags only — never raw notes as identity.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgnicProduct } from "./commerce.js";

export type Tone = "value" | "aspirational" | "social_proof" | "expert" | "playful";
export const TONES: readonly Tone[] = ["value", "aspirational", "social_proof", "expert", "playful"];

export interface PersonaProfile {
  consent: boolean;
  /** Distilled persona tags, e.g. ["student", "budget-conscious", "smart-casual"]. */
  tags: string[];
  budgetBand?: "low" | "mid" | "high";
  country?: string;
  /** Short freeform "about me", kept local only; never used as identity. */
  note?: string;
  updatedAt?: string;
}

export interface RankedItem {
  product: AgnicProduct;
  tone: Tone;
  attrs: string[];
  score: number;
  why: string;
}

interface Stat {
  impressions: number;
  conversions: number;
}

interface Impression {
  sku: string;
  title?: string;
  tone: Tone;
  attrs: string[];
  at: string;
}

interface HistoryEntry {
  sku: string;
  title?: string;
  price_minor?: number;
  currency?: string;
  tone?: Tone;
  attrs?: string[];
  /** "proceed" = user chose to buy; "purchased" = checkout completed (weighted higher). */
  stage?: "proceed" | "purchased";
  at: string;
}

interface ModelData {
  profile: PersonaProfile;
  tone: Record<string, Stat>;
  attr: Record<string, Stat>;
  impressions: Impression[];
  history: HistoryEntry[];
}

const IMPRESSIONS_MAX = 60;
const HISTORY_MAX = 100;

// Coarse attribute lexicon: cheap, transparent tags derived from a product title.
const LEXICON: ReadonlyArray<readonly [string, RegExp]> = [
  ["formal", /blazer|suit|dress shirt|formal|tie|oxford/i],
  ["casual", /tee|t-shirt|hoodie|jeans|casual|sneaker|joggers/i],
  ["minimalist", /minimal|plain|classic|simple|essential/i],
  ["tech", /wireless|smart|usb|charger|electronic|gadget|bluetooth/i],
  ["home", /lamp|mug|kitchen|decor|home|candle|cushion/i],
  ["outdoor", /hiking|outdoor|camp|water bottle|trail|backpack/i],
  ["accessory", /charm|sticker|bag|wallet|watch|belt|scarf/i],
];

const emptyProfile = (): PersonaProfile => ({ consent: false, tags: [] });
const bump = (s: Stat | undefined, key: "impressions" | "conversions", by = 1): Stat => {
  const next = s ?? { impressions: 0, conversions: 0 };
  return { ...next, [key]: next[key] + by };
};
/** Laplace-smoothed conversion rate: an unseen arm scores 0.5 (neutral). */
const rate = (s: Stat | undefined): number => ((s?.conversions ?? 0) + 1) / ((s?.impressions ?? 0) + 2);
const uniq = (xs: string[]): string[] => [...new Set(xs)];

export interface PreferenceModelOptions {
  /** Exploration probability for the tone bandit. Default 0.2. */
  epsilon?: number;
  /** Injectable RNG for deterministic tests. Default Math.random. */
  rng?: () => number;
}

export class PreferenceModel {
  private data: ModelData;
  private readonly epsilon: number;
  private readonly rng: () => number;

  constructor(
    private readonly file: string,
    options: PreferenceModelOptions = {},
  ) {
    this.epsilon = options.epsilon ?? 0.2;
    this.rng = options.rng ?? Math.random;
    this.data = this.load();
  }

  private load(): ModelData {
    const base: ModelData = { profile: emptyProfile(), tone: {}, attr: {}, impressions: [], history: [] };
    if (!existsSync(this.file)) return base;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<ModelData>;
      return {
        profile: raw.profile ?? base.profile,
        tone: raw.tone ?? {},
        attr: raw.attr ?? {},
        impressions: Array.isArray(raw.impressions) ? raw.impressions : [],
        history: Array.isArray(raw.history) ? raw.history : [],
      };
    } catch {
      return base;
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      /* best-effort; a read-only FS must never break a purchase */
    }
  }

  /** The stored persona (a copy). */
  profile(): PersonaProfile {
    return { ...this.data.profile, tags: [...this.data.profile.tags] };
  }

  /** Set the persona — only stored with consent; `consent:false` clears everything personal. */
  setProfile(input: { consent: boolean; tags?: string[]; budgetBand?: PersonaProfile["budgetBand"]; country?: string; note?: string }): PersonaProfile {
    if (!input.consent) {
      this.data.profile = emptyProfile();
      this.save();
      return this.profile();
    }
    this.data.profile = {
      consent: true,
      tags: uniq((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)).slice(0, 12),
      ...(input.budgetBand ? { budgetBand: input.budgetBand } : {}),
      ...(input.country ? { country: input.country } : {}),
      ...(input.note ? { note: input.note.slice(0, 300) } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.profile();
  }

  /** Wipe persona, history and learned stats. */
  clear(): void {
    this.data = { profile: emptyProfile(), tone: {}, attr: {}, impressions: [], history: [] };
    this.save();
  }

  /** Coarse, explainable attributes for a product (price band + title keywords). */
  deriveAttrs(product: AgnicProduct): string[] {
    const attrs: string[] = [];
    const p = product.price_minor;
    if (p !== undefined) attrs.push(p < 3000 ? "budget-friendly" : p < 15000 ? "mid-range" : "premium");
    const title = product.title ?? "";
    for (const [tag, re] of LEXICON) if (re.test(title)) attrs.push(tag);
    return uniq(attrs);
  }

  /**
   * Rank Agnic's products by persona + learned conversion, then assign each a distinct
   * pitch tone (the A/B arm). Returns the top `count`, best first.
   */
  rank(products: AgnicProduct[], count = 5): RankedItem[] {
    const prof = this.data.profile;
    const budgetRank = { low: 0, mid: 1, high: 2 } as const;
    const priceBand = (p?: number): 0 | 1 | 2 | undefined => (p === undefined ? undefined : p < 3000 ? 0 : p < 15000 ? 1 : 2);

    const scored = products.map((product, i) => {
      const attrs = this.deriveAttrs(product);
      const relevance = products.length - i; // Agnic's own search order
      const personaOverlap = prof.consent ? attrs.filter((a) => prof.tags.includes(a)).length : 0;
      let budgetAlign = 0;
      if (prof.consent && prof.budgetBand) {
        const want = budgetRank[prof.budgetBand];
        const got = priceBand(product.price_minor);
        if (got !== undefined) budgetAlign = got === want ? 1 : got < want ? 0.25 : -0.5;
      }
      const learned = attrs.reduce((s, a) => s + (rate(this.data.attr[a]) - 0.5), 0);
      const score = relevance * 1.0 + personaOverlap * 2.0 + budgetAlign * 1.5 + learned * 3.0;
      const why = [
        personaOverlap > 0 ? `matches ${personaOverlap} of your tags` : "",
        budgetAlign > 0 ? "fits your budget band" : budgetAlign < 0 ? "above your budget band" : "",
        learned > 0.05 ? "similar to what you've picked before" : "",
      ].filter(Boolean).join("; ") || "top search relevance";
      return { product, attrs, score, why };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, Math.max(1, count));
    const tones = this.pickTones(top.length);
    return top.map((s, i) => ({ ...s, tone: tones[i]! }));
  }

  /**
   * Distinct tones for the shown products (epsilon-greedy): mostly the tones that
   * have converted best, occasionally the least-seen one so the model keeps learning.
   */
  pickTones(n: number): Tone[] {
    const rated = TONES.map((t) => ({ t, r: rate(this.data.tone[t]), impr: this.data.tone[t]?.impressions ?? 0 }));
    let order = [...rated].sort((a, b) => b.r - a.r || a.impr - b.impr).map((x) => x.t);
    if (this.rng() < this.epsilon) {
      const leastSeen = [...rated].sort((a, b) => a.impr - b.impr)[0]!.t;
      order = [leastSeen, ...order.filter((t) => t !== leastSeen)];
    }
    const out: Tone[] = [];
    for (let i = 0; i < n; i++) out.push(order[i % order.length]!);
    return out;
  }

  /** Record that these products were shown (one impression each, with its assigned tone). */
  recordImpressions(items: Array<{ sku: string; title?: string; tone: Tone; attrs: string[] }>): void {
    const at = new Date().toISOString();
    for (const it of items) {
      this.data.tone[it.tone] = bump(this.data.tone[it.tone], "impressions");
      for (const a of it.attrs) this.data.attr[a] = bump(this.data.attr[a], "impressions");
      this.data.impressions.push({ sku: it.sku, ...(it.title ? { title: it.title } : {}), tone: it.tone, attrs: it.attrs, at });
    }
    if (this.data.impressions.length > IMPRESSIONS_MAX) this.data.impressions = this.data.impressions.slice(-IMPRESSIONS_MAX);
    this.save();
  }

  /**
   * The user proceeded to buy `sku` — credit its shown tone and attributes with `weight`
   * (default 1). Matches the most recent impression of that sku (so we learn which pitch
   * won) and remembers it, so a later `recordPurchase` can add more on top.
   */
  recordConversion(sku: string, extra: { title?: string; price_minor?: number; currency?: string } = {}, weight = 1): { credited: boolean; tone?: Tone } {
    let idx = -1;
    for (let i = this.data.impressions.length - 1; i >= 0; i--) {
      if (this.data.impressions[i]!.sku === sku) { idx = i; break; }
    }
    const at = new Date().toISOString();
    if (idx < 0) {
      this.data.history.push({ sku, stage: "proceed", at, ...extra });
      this.trimHistory();
      this.save();
      return { credited: false };
    }
    const im = this.data.impressions.splice(idx, 1)[0]!;
    this.data.tone[im.tone] = bump(this.data.tone[im.tone], "conversions", weight);
    for (const a of im.attrs) this.data.attr[a] = bump(this.data.attr[a], "conversions", weight);
    this.data.history.push({ sku, tone: im.tone, attrs: im.attrs, stage: "proceed", at, ...(im.title ? { title: im.title } : {}), ...extra });
    this.trimHistory();
    this.save();
    return { credited: true, tone: im.tone };
  }

  /**
   * The purchase COMPLETED — add extra weight (default 2) on top of the proceed-to-buy
   * credit, since a paid order is a much stronger signal than merely choosing. Reuses the
   * tone/attributes remembered from the proceed step (the impression is already consumed).
   */
  recordPurchase(sku: string, weight = 2): { credited: boolean; tone?: Tone } {
    let entry: HistoryEntry | undefined;
    for (let i = this.data.history.length - 1; i >= 0; i--) {
      const h = this.data.history[i]!;
      if (h.sku === sku && h.tone) { entry = h; break; }
    }
    if (!entry || !entry.tone) return { credited: false };
    this.data.tone[entry.tone] = bump(this.data.tone[entry.tone], "conversions", weight);
    for (const a of entry.attrs ?? []) this.data.attr[a] = bump(this.data.attr[a], "conversions", weight);
    this.data.history.push({ sku, tone: entry.tone, ...(entry.attrs ? { attrs: entry.attrs } : {}), ...(entry.title ? { title: entry.title } : {}), stage: "purchased", at: new Date().toISOString() });
    this.trimHistory();
    this.save();
    return { credited: true, tone: entry.tone };
  }

  /**
   * Seed queries for the "For You" default feed, newest first: the titles of things the
   * user has bought/chosen. Empty for a first-time user — so the default page starts blank.
   */
  purchaseSeeds(max = 3): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = this.data.history.length - 1; i >= 0 && out.length < max; i--) {
      const t = this.data.history[i]!.title?.trim();
      if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    }
    return out;
  }

  /** A readable snapshot for transparency / debugging (per-tone and per-attribute rates). */
  stats(): { tones: Array<{ tone: Tone; impressions: number; conversions: number; rate: number }>; attrs: Array<{ attr: string; impressions: number; conversions: number; rate: number }>; history: HistoryEntry[] } {
    const tones = TONES.map((t) => ({ tone: t, impressions: this.data.tone[t]?.impressions ?? 0, conversions: this.data.tone[t]?.conversions ?? 0, rate: Number(rate(this.data.tone[t]).toFixed(3)) }));
    const attrs = Object.keys(this.data.attr).map((a) => ({ attr: a, impressions: this.data.attr[a]!.impressions, conversions: this.data.attr[a]!.conversions, rate: Number(rate(this.data.attr[a]).toFixed(3)) }));
    return { tones, attrs, history: [...this.data.history].slice(-20).reverse() };
  }

  private trimHistory(): void {
    if (this.data.history.length > HISTORY_MAX) this.data.history = this.data.history.slice(-HISTORY_MAX);
  }
}
