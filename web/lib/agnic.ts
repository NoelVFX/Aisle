import type { Product, Tone } from "./types";

/**
 * Live product data from Agnic (real Shopify catalogue). We NEVER fabricate products:
 * title, price, image, sku and merchant all come from Agnic's search response. Only the
 * tone pitch is added later by the LLM (see pitch.ts).
 *
 * Requires AGNIC_TOKEN (server-side). The response shape is parsed defensively because
 * Agnic's field names aren't fully pinned in the docs.
 */

const BASE = () => process.env.AGNIC_BASE_URL || "https://api.agnic.ai";
export const agnicConfigured = () => Boolean(process.env.AGNIC_TOKEN);

type Raw = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function pickImage(p: Raw): string {
  const imgs = p["images"];
  const first = Array.isArray(imgs) && imgs.length ? imgs[0] : undefined;
  const fromArray = typeof first === "string" ? first : first && typeof first === "object" ? str((first as Raw)["url"]) ?? str((first as Raw)["src"]) : undefined;
  const cands = [str(p["image"]), str(p["image_url"]), str(p["imageUrl"]), str(p["featured_image"]), str(p["thumbnail"]), fromArray];
  return cands.find((x) => x && /^https?:\/\//.test(x)) ?? "";
}

function priceMinor(p: Raw): number {
  const m = num(p["price_minor"]) ?? num(p["priceMinor"]) ?? num(p["amount_minor"]);
  if (m !== undefined) return m;
  const dollars = num(p["price"]) ?? num(p["amount"]);
  return dollars !== undefined ? Math.round(dollars * 100) : 0;
}

function merchantId(p: Raw): string {
  const m = p["merchant"];
  return (m && typeof m === "object" ? str((m as Raw)["merchant_id"]) ?? str((m as Raw)["id"]) : undefined) ?? str(p["merchant_id"]) ?? str(p["merchantId"]) ?? "";
}

/** Coarse attributes for ranking (derived, not claimed as product facts). */
function deriveAttrs(title: string, cents: number): string[] {
  const a: string[] = [];
  if (cents) a.push(cents < 3000 ? "budget-friendly" : cents < 15000 ? "mid-range" : "premium");
  const t = title.toLowerCase();
  if (/blazer|suit|shirt|tie|dress/.test(t)) a.push("formal");
  if (/tee|hoodie|casual|sneaker/.test(t)) a.push("casual");
  if (/keyboard|mouse|usb|wireless|tech|charger|cable/.test(t)) a.push("tech");
  if (/desk|lamp|mug|home|chair/.test(t)) a.push("home");
  return a;
}

function mapProduct(raw: unknown): Product | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Raw;
  const sku = str(p["sku"]) ?? str(p["id"]) ?? str(p["variant_id"]);
  const title = str(p["title"]) ?? str(p["name"]);
  if (!sku || !title) return null;
  if (p["available"] === false) return null;
  const cents = priceMinor(p);
  return {
    sku,
    title,
    priceMinor: cents,
    currency: str(p["currency"]) ?? "USD",
    merchantId: merchantId(p),
    image: pickImage(p),
    tone: "value" as Tone, // replaced by the pitch layer
    pitch: "",
    attrs: deriveAttrs(title, cents),
  };
}

async function get(path: string): Promise<Raw | null> {
  const token = process.env.AGNIC_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(`${BASE()}${path}`, { headers: { "X-Agnic-Token": token }, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    return (await resp.json()) as Raw;
  } catch {
    return null;
  }
}

/** Search the Agnic network for real products. Returns [] on no token / error / no results. */
export async function searchAgnic(query: string, country = "US", limit = 5): Promise<Product[]> {
  const q = query.trim();
  if (!q) return [];
  const params = new URLSearchParams({ q, country, limit: String(limit) });
  const data = await get(`/api/autofill/products/search?${params}`);
  const arr = data && Array.isArray(data["products"]) ? (data["products"] as unknown[]) : [];
  const out: Product[] = [];
  for (const r of arr) {
    const m = mapProduct(r);
    if (m) out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

/** What pairs with what (the mapping is generic; the returned products are real Agnic results). */
const COMP_MAP: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/keyboard/i, ["mouse", "mouse pad"]],
  [/\bmouse\b/i, ["keyboard", "mouse pad"]],
  [/blazer|jacket|suit/i, ["dress shirt", "tie"]],
  [/\bshirt/i, ["tie", "cufflinks"]],
  [/desk\b/i, ["desk lamp", "office chair"]],
  [/lamp/i, ["desk organizer"]],
  [/shoe|sneaker|derby|loafer/i, ["socks"]],
  [/phone|iphone|pixel/i, ["phone case", "charger"]],
  [/camera/i, ["memory card", "tripod"]],
  [/laptop|macbook/i, ["laptop sleeve", "wireless mouse"]],
];

/** Real complementary products for the checkout moment, pulled from Agnic. */
export async function searchComplements(product: Product, country = "US"): Promise<Product[]> {
  let queries: readonly string[] = [];
  for (const [re, c] of COMP_MAP) if (re.test(product.title)) { queries = c; break; }
  if (!queries.length) return [];
  const found: Product[] = [];
  const seen = new Set<string>([product.sku]);
  for (const q of queries.slice(0, 3)) {
    const r = await searchAgnic(q, country, 2);
    const pick = r.find((x) => !seen.has(x.sku));
    if (pick) { seen.add(pick.sku); found.push(pick); }
  }
  return found;
}
