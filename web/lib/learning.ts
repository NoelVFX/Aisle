import type { Product, Tone, Signals, Counts } from "./types";
import { COLOR_NAMES, colorMatches } from "./colors";

/**
 * A lightweight behavioral preference model. It turns what the shopper actually does
 * (impressions -> picks -> purchases) into signals that re-rank future recommendations,
 * complementing the STATED profile with REVEALED preference and conversion.
 *
 * Signals are captured on the client (localStorage) and sent with each chat request; all
 * the scoring below is pure so the chat route can apply it server-side when it ranks.
 */

export const emptySignals = (): Signals => ({ attrs: {}, colors: {}, tones: {}, bands: {}, merchants: {}, totals: { imp: 0, pick: 0, buy: 0 } });

/** Coerce anything from storage/network into a valid Signals object. */
export function normalizeSignals(s: unknown): Signals {
  const e = emptySignals();
  if (!s || typeof s !== "object") return e;
  const o = s as Partial<Signals>;
  const dim = (m: unknown): Record<string, Counts> => {
    const out: Record<string, Counts> = {};
    if (m && typeof m === "object") for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      const c = v as Partial<Counts>;
      out[k] = { imp: Number(c?.imp) || 0, pick: Number(c?.pick) || 0, buy: Number(c?.buy) || 0 };
    }
    return out;
  };
  return {
    attrs: dim(o.attrs), colors: dim(o.colors), tones: dim(o.tones), bands: dim(o.bands), merchants: dim(o.merchants),
    totals: { imp: Number(o.totals?.imp) || 0, pick: Number(o.totals?.pick) || 0, buy: Number(o.totals?.buy) || 0 },
  };
}

export function priceBand(minor: number): string {
  const d = minor / 100;
  if (d < 25) return "0-25";
  if (d < 75) return "25-75";
  if (d < 150) return "75-150";
  if (d < 300) return "150-300";
  return "300+";
}

/** Colors a product reads as, from its title/attrs (shades included). */
function productColors(p: Product): string[] {
  return COLOR_NAMES.filter((c) => colorMatches(p.title, c) || p.attrs.some((a) => colorMatches(a, c)));
}

function bump(m: Record<string, Counts>, key: string, ev: keyof Counts) {
  const c = m[key] ?? (m[key] = { imp: 0, pick: 0, buy: 0 });
  c[ev] += 1;
}

function record(s: Signals, p: Product, ev: keyof Counts) {
  s.totals[ev] += 1;
  for (const a of p.attrs) bump(s.attrs, a, ev);
  for (const c of productColors(p)) bump(s.colors, c, ev);
  bump(s.tones, p.tone, ev);
  bump(s.bands, priceBand(p.priceMinor), ev);
  if (p.merchantId) bump(s.merchants, p.merchantId, ev);
}

export function recordImpressions(s: Signals, products: Product[]): Signals { for (const p of products) record(s, p, "imp"); return s; }
export function recordPick(s: Signals, p: Product): Signals { record(s, p, "pick"); return s; }
export function recordPurchase(s: Signals, p: Product): Signals { record(s, p, "buy"); return s; }

/** True once there is enough behavior to lean on. */
export function hasHistory(s: Signals): boolean { return s.totals.buy + s.totals.pick > 0; }

/** Preference weight for one dimension value: smoothed buy-rate x volume, so a value needs
 *  both conversion AND repeat interest to score. A purchase counts far more than a pick. */
function weight(c?: Counts): number {
  if (!c) return 0;
  const conversion = (c.buy + 0.4) / (c.imp + 2); // Laplace-smoothed
  return conversion * Math.log1p(c.buy + 0.4 * c.pick);
}

/** How well a candidate matches learned buying patterns (0 when there is no history yet). */
export function behaviorScore(p: Product, s: Signals): number {
  if (!hasHistory(s)) return 0;
  let score = 0;
  for (const a of p.attrs) score += weight(s.attrs[a]);
  for (const c of productColors(p)) score += 1.2 * weight(s.colors[c]);
  score += 0.8 * weight(s.bands[priceBand(p.priceMinor)]);
  if (p.merchantId) score += 0.6 * weight(s.merchants[p.merchantId]);
  return score;
}

/** Top attributes/colors the shopper actually buys, to bias search (e.g. For You). */
export function learnedTags(s: Signals, n = 3): string[] {
  const rank = (m: Record<string, Counts>) => Object.entries(m).filter(([, c]) => c.buy > 0).sort((a, b) => b[1].buy - a[1].buy).map(([k]) => k);
  return [...rank(s.colors), ...rank(s.attrs)].slice(0, n);
}

/** The tone that converts best (a simple bandit): exploit once it has enough impressions. */
export function bestTone(s: Signals, minImpressions = 6): Tone | undefined {
  let winner: Tone | undefined;
  let bestConv = -1;
  for (const [tone, c] of Object.entries(s.tones)) {
    if (c.imp < minImpressions) continue;
    const conv = (c.buy + 0.3) / (c.imp + 1);
    if (conv > bestConv) { bestConv = conv; winner = tone as Tone; }
  }
  return winner;
}

/** Overall purchase conversion rate (buys per impression). */
export function conversionRate(s: Signals): number {
  return s.totals.imp ? s.totals.buy / s.totals.imp : 0;
}
