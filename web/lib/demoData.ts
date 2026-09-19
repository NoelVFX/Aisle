import type { Product, Tone, ToolRec } from "./types";

/**
 * Keyword-matched imagery via LoremFlickr, so a "keyboard" actually shows a keyboard
 * (picsum returns random photos, which is why the old cards looked unrelated). `lock`
 * pins a stable image per product. The card has a surface background as a graceful
 * fallback if the image is blocked.
 */
const img = (keywords: string, lock: number, w = 600, h = 380) =>
  `https://loremflickr.com/${w}/${h}/${encodeURIComponent(keywords)}?lock=${lock}`;

/** Realistic catalogue rows (demo mode). Prices in minor units, CAD to match the Agnic sandbox. */
export const CATALOGUE: Record<string, Product[]> = {
  keyboard: [
    { sku: "kb-tkl-graphite", title: "Aster TKL Mechanical, Graphite", priceMinor: 12900, currency: "CAD", merchantId: "m_keyhaus", image: img("keyboard", 21), tone: "value", pitch: "Gasket-mounted feel usually found at twice the price. Hot-swap, no solder.", attrs: ["tech", "mid-range"], why: "matches your tags" },
    { sku: "kb-65-cream", title: "Aster 65% Wireless, Cream", priceMinor: 15400, currency: "CAD", merchantId: "m_keyhaus", image: img("keyboard", 22), tone: "aspirational", pitch: "A desk you want to sit at. Cream keys, brass weight, three-device Bluetooth.", attrs: ["tech", "premium"] },
    { sku: "kb-full-black", title: "Meridian Full-size, Black", priceMinor: 8900, currency: "CAD", merchantId: "m_keyhaus", image: img("keyboard", 23), tone: "playful", pitch: "Numpad, knob, and a satisfying thock. Everything, nothing precious.", attrs: ["tech", "budget-friendly"] },
    { sku: "kb-ergo-split", title: "Portico Split Ergonomic", priceMinor: 19900, currency: "CAD", merchantId: "m_keyhaus", image: img("keyboard", 24), tone: "expert", pitch: "Tented halves that let your shoulders sit where they want. Our pick for long days.", attrs: ["tech", "premium"] },
    { sku: "kb-low-silver", title: "Nova Low-Profile, Silver", priceMinor: 10900, currency: "CAD", merchantId: "m_keyhaus", image: img("keyboard", 25), tone: "social_proof", pitch: "The one commuters keep recommending. Slim travel, quiet switches, all-metal deck.", attrs: ["tech", "mid-range"] },
  ],
  blazer: [
    { sku: "blz-oxford-navy", title: "Oxford Wool Blazer, Navy", priceMinor: 14900, currency: "CAD", merchantId: "m_northcott", image: img("blazer", 31), tone: "value", pitch: "Half-canvas construction at a ready-to-wear price. Holds a press for years.", attrs: ["formal", "mid-range"], why: "similar to what you've picked before" },
    { sku: "blz-linen-sage", title: "Linen Blend Blazer, Sage", priceMinor: 11200, currency: "CAD", merchantId: "m_northcott", image: img("blazer", 32), tone: "aspirational", pitch: "The jacket that makes a Tuesday feel deliberate. Breathes through August.", attrs: ["formal", "mid-range"] },
    { sku: "blz-cord-rust", title: "Corduroy Blazer, Rust", priceMinor: 9800, currency: "CAD", merchantId: "m_field", image: img("blazer", 33), tone: "social_proof", pitch: "The one reviewers keep re-buying in a second colour. Soft, warm, forgiving.", attrs: ["casual", "budget-friendly"] },
    { sku: "blz-tweed-slate", title: "Donegal Tweed Blazer, Slate", priceMinor: 17600, currency: "CAD", merchantId: "m_field", image: img("blazer", 34), tone: "expert", pitch: "Woven in Donegal, flecked to hide a decade of wear. Our pick for cold rooms.", attrs: ["formal", "premium"] },
    { sku: "blz-cotton-stone", title: "Cotton Blazer, Stone", priceMinor: 8600, currency: "CAD", merchantId: "m_field", image: img("blazer", 35), tone: "playful", pitch: "Unlined and easygoing. Throw it over a tee and look like you tried.", attrs: ["casual", "budget-friendly"] },
  ],
  desk: [
    { sku: "desk-oak-standing", title: "Standing Desk, White Oak", priceMinor: 62000, currency: "CAD", merchantId: "m_northcott", image: img("desk", 41), tone: "expert", pitch: "Dual motors, real oak veneer, four memory heights. Rated to 120kg.", attrs: ["home", "premium"] },
    { sku: "desk-walnut-writing", title: "Writing Desk, Walnut", priceMinor: 38000, currency: "CAD", merchantId: "m_field", image: img("desk", 42), tone: "value", pitch: "Cable tray, two drawers, no wobble. The one that outlasts the apartment.", attrs: ["home", "mid-range"] },
    { sku: "desk-compact-white", title: "Compact Desk, White", priceMinor: 21000, currency: "CAD", merchantId: "m_field", image: img("desk", 43), tone: "social_proof", pitch: "Fits the small room everyone forgets to plan for. Steady, simple, cheap to love.", attrs: ["home", "budget-friendly"] },
    { sku: "desk-glass-black", title: "Glass Top Desk, Black", priceMinor: 29000, currency: "CAD", merchantId: "m_northcott", image: img("desk", 44), tone: "aspirational", pitch: "Tempered glass on a matte frame. The workspace that photographs well.", attrs: ["home", "mid-range"] },
  ],
};

/** Complements keyed by a rough item category. */
export const COMPLEMENTS: Record<string, Product[]> = {
  keyboard: [
    { sku: "ms-ergo-graphite", title: "Ergo Wireless Mouse", priceMinor: 6900, currency: "CAD", merchantId: "m_keyhaus", image: img("mouse", 51, 300, 200), tone: "value", pitch: "Pairs with your board.", attrs: ["tech"] },
    { sku: "pad-desk-charcoal", title: "Desk Mat, Charcoal", priceMinor: 3400, currency: "CAD", merchantId: "m_keyhaus", image: img("mousepad", 52, 300, 200), tone: "value", pitch: "Full-desk felt.", attrs: ["tech"] },
    { sku: "rest-wrist-walnut", title: "Walnut Wrist Rest", priceMinor: 2900, currency: "CAD", merchantId: "m_keyhaus", image: img("desk", 53, 300, 200), tone: "value", pitch: "Matches the case.", attrs: ["tech"] },
  ],
  blazer: [
    { sku: "shirt-ox-white", title: "Oxford Shirt, White", priceMinor: 5900, currency: "CAD", merchantId: "m_northcott", image: img("shirt", 61, 300, 200), tone: "value", pitch: "Under any jacket.", attrs: ["formal"] },
    { sku: "tie-knit-navy", title: "Knit Tie, Navy", priceMinor: 3800, currency: "CAD", merchantId: "m_northcott", image: img("necktie", 62, 300, 200), tone: "value", pitch: "Texture, not shine.", attrs: ["formal"] },
    { sku: "shoe-derby-brown", title: "Leather Derbies, Brown", priceMinor: 16900, currency: "CAD", merchantId: "m_field", image: img("shoes", 63, 300, 200), tone: "value", pitch: "Finishes the look.", attrs: ["formal"] },
  ],
  desk: [
    { sku: "lamp-task-black", title: "Task Lamp, Black", priceMinor: 8900, currency: "CAD", merchantId: "m_northcott", image: img("lamp", 71, 300, 200), tone: "value", pitch: "Warm, dimmable.", attrs: ["home"] },
    { sku: "org-cable-tray", title: "Cable Tray", priceMinor: 3200, currency: "CAD", merchantId: "m_field", image: img("cables", 72, 300, 200), tone: "value", pitch: "Hides the mess.", attrs: ["home"] },
  ],
};

/** "For You" recommendations shown after a purchase (memory-seeded). */
export const FOR_YOU: Product[] = [
  { sku: "kb-artisan-cap", title: "Artisan Keycap, Ember", priceMinor: 4200, currency: "CAD", merchantId: "m_keyhaus", image: img("keyboard", 81), tone: "playful", pitch: "Because you bought the Aster. One loud key, on purpose.", attrs: ["tech"], why: "based on your last purchase" },
  { sku: "ms-ergo-graphite", title: "Ergo Wireless Mouse", priceMinor: 6900, currency: "CAD", merchantId: "m_keyhaus", image: img("mouse", 82), tone: "value", pitch: "Completes the setup you started.", attrs: ["tech"], why: "pairs with what you own" },
  { sku: "cable-usbc-braided", title: "Braided USB-C Cable, Sand", priceMinor: 2400, currency: "CAD", merchantId: "m_keyhaus", image: img("cable", 83), tone: "value", pitch: "Coiled, aviator connector, matches the board.", attrs: ["tech"], why: "for your keyboard" },
];

export const TOOL_RECS: Record<string, ToolRec> = {
  email: { toolName: "Resend", category: "Transactional email API", checkoutUrl: "https://resend.com/pricing", plan: "Pro", why: "Developer-first email with an official MCP server and clean React email support.", alternatives: [{ toolName: "Postmark", why: "Rock-solid deliverability" }, { toolName: "Loops", why: "Marketing plus transactional" }], hasMcp: true, buySku: "saas:resend-pro", planPriceMinor: 2000, planCurrency: "USD" },
  payments: { toolName: "Stripe", category: "Payments and billing", checkoutUrl: "https://stripe.com/pricing", plan: "Standard", why: "The default rails for card, subscription, and usage billing, with strong tooling.", alternatives: [{ toolName: "Paddle", why: "Merchant of record" }, { toolName: "Lemon Squeezy", why: "Simple for indie" }], hasMcp: true, buySku: "saas:stripe-standard", planPriceMinor: 0, planCurrency: "USD" },
  search: { toolName: "Algolia", category: "Hosted search", checkoutUrl: "https://www.algolia.com/pricing", plan: "Grow", why: "Instant, typo-tolerant search with generous limits and a mature API.", alternatives: [{ toolName: "Typesense", why: "Open source, self-host" }, { toolName: "Meilisearch", why: "Fast to set up" }], hasMcp: false, buySku: "saas:algolia-grow", planPriceMinor: 5000, planCurrency: "USD" },
};

/** Synthetic "plan products" so a recommended SaaS plan can flow to the approval card. */
export const SAAS_PLANS: Product[] = Object.values(TOOL_RECS)
  .filter((r) => r.planPriceMinor > 0)
  .map((r, i) => ({
    sku: r.buySku,
    title: `${r.toolName} — ${r.plan} plan`,
    priceMinor: r.planPriceMinor,
    currency: r.planCurrency,
    merchantId: r.checkoutUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    image: img("technology", 90 + i),
    tone: "expert",
    pitch: r.why,
    attrs: ["saas"],
  }));

export function toneLabel(t: Tone): string {
  return { value: "Value", aspirational: "Aspirational", social_proof: "Popular", expert: "Expert pick", playful: "Playful" }[t];
}

export function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}
