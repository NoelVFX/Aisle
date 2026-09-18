import type { Product, Tone, ToolRec } from "./types";

const img = (seed: string, w = 480, h = 300) => `https://picsum.photos/seed/${seed}/${w}/${h}`;

/** Realistic catalogue rows (demo mode). Prices in minor units, CAD to match the Agnic sandbox. */
export const CATALOGUE: Record<string, Product[]> = {
  blazer: [
    { sku: "blz-oxford-navy", title: "Oxford Wool Blazer, Navy", priceMinor: 14900, currency: "CAD", merchantId: "m_northcott", image: img("navy-wool-blazer"), tone: "value", pitch: "Half-canvas construction at a ready-to-wear price. Holds a press for years.", attrs: ["formal", "mid-range"], why: "similar to what you've picked before" },
    { sku: "blz-linen-sage", title: "Linen Blend Blazer, Sage", priceMinor: 11200, currency: "CAD", merchantId: "m_northcott", image: img("sage-linen-blazer"), tone: "aspirational", pitch: "The jacket that makes a Tuesday feel deliberate. Breathes through August.", attrs: ["formal", "mid-range"] },
    { sku: "blz-cord-rust", title: "Corduroy Blazer, Rust", priceMinor: 9800, currency: "CAD", merchantId: "m_field", image: img("rust-corduroy-blazer"), tone: "social_proof", pitch: "The one reviewers keep re-buying in a second colour. Soft, warm, forgiving.", attrs: ["casual", "budget-friendly"] },
    { sku: "blz-tweed-slate", title: "Donegal Tweed Blazer, Slate", priceMinor: 17600, currency: "CAD", merchantId: "m_field", image: img("slate-tweed-blazer"), tone: "expert", pitch: "Woven in Donegal, flecked to hide a decade of wear. Our pick for cold rooms.", attrs: ["formal", "premium"] },
  ],
  keyboard: [
    { sku: "kb-tkl-graphite", title: "Aster TKL Mechanical, Graphite", priceMinor: 12900, currency: "CAD", merchantId: "m_keyhaus", image: img("graphite-mechanical-keyboard"), tone: "value", pitch: "Gasket-mounted feel usually found at twice the price. Hot-swap, no solder.", attrs: ["tech", "mid-range"], why: "matches your tags" },
    { sku: "kb-65-cream", title: "Aster 65% Wireless, Cream", priceMinor: 15400, currency: "CAD", merchantId: "m_keyhaus", image: img("cream-65-keyboard"), tone: "aspirational", pitch: "A desk you want to sit at. Cream keys, brass weight, three-device Bluetooth.", attrs: ["tech", "premium"] },
    { sku: "kb-full-black", title: "Meridian Full-size, Black", priceMinor: 8900, currency: "CAD", merchantId: "m_keyhaus", image: img("black-fullsize-keyboard"), tone: "playful", pitch: "Numpad, knob, and a satisfying thock. Everything, nothing precious.", attrs: ["tech", "budget-friendly"] },
  ],
  desk: [
    { sku: "desk-oak-standing", title: "Standing Desk, White Oak", priceMinor: 62000, currency: "CAD", merchantId: "m_northcott", image: img("white-oak-standing-desk"), tone: "expert", pitch: "Dual motors, real oak veneer, four memory heights. Rated to 120kg.", attrs: ["home", "premium"] },
    { sku: "desk-walnut-writing", title: "Writing Desk, Walnut", priceMinor: 38000, currency: "CAD", merchantId: "m_field", image: img("walnut-writing-desk"), tone: "value", pitch: "Cable tray, two drawers, no wobble. The one that outlasts the apartment.", attrs: ["home", "mid-range"] },
  ],
};

/** Complements keyed by a rough item category. */
export const COMPLEMENTS: Record<string, Product[]> = {
  keyboard: [
    { sku: "ms-ergo-graphite", title: "Ergo Wireless Mouse", priceMinor: 6900, currency: "CAD", merchantId: "m_keyhaus", image: img("ergo-wireless-mouse", 300, 200), tone: "value", pitch: "Pairs with your board.", attrs: ["tech"] },
    { sku: "pad-desk-charcoal", title: "Desk Mat, Charcoal", priceMinor: 3400, currency: "CAD", merchantId: "m_keyhaus", image: img("charcoal-desk-mat", 300, 200), tone: "value", pitch: "Full-desk felt.", attrs: ["tech"] },
    { sku: "rest-wrist-walnut", title: "Walnut Wrist Rest", priceMinor: 2900, currency: "CAD", merchantId: "m_keyhaus", image: img("walnut-wrist-rest", 300, 200), tone: "value", pitch: "Matches the case.", attrs: ["tech"] },
  ],
  blazer: [
    { sku: "shirt-ox-white", title: "Oxford Shirt, White", priceMinor: 5900, currency: "CAD", merchantId: "m_northcott", image: img("white-oxford-shirt", 300, 200), tone: "value", pitch: "Under any jacket.", attrs: ["formal"] },
    { sku: "tie-knit-navy", title: "Knit Tie, Navy", priceMinor: 3800, currency: "CAD", merchantId: "m_northcott", image: img("navy-knit-tie", 300, 200), tone: "value", pitch: "Texture, not shine.", attrs: ["formal"] },
    { sku: "shoe-derby-brown", title: "Leather Derbies, Brown", priceMinor: 16900, currency: "CAD", merchantId: "m_field", image: img("brown-leather-derby", 300, 200), tone: "value", pitch: "Finishes the look.", attrs: ["formal"] },
  ],
  desk: [
    { sku: "lamp-task-black", title: "Task Lamp, Black", priceMinor: 8900, currency: "CAD", merchantId: "m_northcott", image: img("black-task-lamp", 300, 200), tone: "value", pitch: "Warm, dimmable.", attrs: ["home"] },
    { sku: "org-cable-tray", title: "Cable Tray", priceMinor: 3200, currency: "CAD", merchantId: "m_field", image: img("under-desk-cable-tray", 300, 200), tone: "value", pitch: "Hides the mess.", attrs: ["home"] },
  ],
};

/** "For You" recommendations shown after a purchase (memory-seeded). */
export const FOR_YOU: Product[] = [
  { sku: "kb-artisan-cap", title: "Artisan Keycap, Ember", priceMinor: 4200, currency: "CAD", merchantId: "m_keyhaus", image: img("ember-artisan-keycap"), tone: "playful", pitch: "Because you bought the Aster. One loud key, on purpose.", attrs: ["tech"], why: "based on your last purchase" },
  { sku: "ms-ergo-graphite", title: "Ergo Wireless Mouse", priceMinor: 6900, currency: "CAD", merchantId: "m_keyhaus", image: img("ergo-wireless-mouse"), tone: "value", pitch: "Completes the setup you started.", attrs: ["tech"], why: "pairs with what you own" },
  { sku: "cable-usbc-braided", title: "Braided USB-C Cable, Sand", priceMinor: 2400, currency: "CAD", merchantId: "m_keyhaus", image: img("sand-braided-usbc"), tone: "value", pitch: "Coiled, aviator connector, matches the board.", attrs: ["tech"], why: "for your keyboard" },
];

export const TOOL_RECS: Record<string, ToolRec> = {
  email: { toolName: "Resend", category: "Transactional email API", checkoutUrl: "https://resend.com/pricing", plan: "Pro", why: "Developer-first email with an official MCP server and clean React email support.", alternatives: [{ toolName: "Postmark", why: "Rock-solid deliverability" }, { toolName: "Loops", why: "Marketing plus transactional" }], hasMcp: true, buySku: "saas:resend-pro", planPriceMinor: 2000, planCurrency: "USD" },
  payments: { toolName: "Stripe", category: "Payments and billing", checkoutUrl: "https://stripe.com/pricing", plan: "Standard", why: "The default rails for card, subscription, and usage billing, with strong tooling.", alternatives: [{ toolName: "Paddle", why: "Merchant of record" }, { toolName: "Lemon Squeezy", why: "Simple for indie" }], hasMcp: true, buySku: "saas:stripe-standard", planPriceMinor: 0, planCurrency: "USD" },
  search: { toolName: "Algolia", category: "Hosted search", checkoutUrl: "https://www.algolia.com/pricing", plan: "Grow", why: "Instant, typo-tolerant search with generous limits and a mature API.", alternatives: [{ toolName: "Typesense", why: "Open source, self-host" }, { toolName: "Meilisearch", why: "Fast to set up" }], hasMcp: false, buySku: "saas:algolia-grow", planPriceMinor: 5000, planCurrency: "USD" },
};

/** Synthetic "plan products" so a recommended SaaS plan can flow to the approval card. */
export const SAAS_PLANS: Product[] = Object.values(TOOL_RECS)
  .filter((r) => r.planPriceMinor > 0)
  .map((r) => ({
    sku: r.buySku,
    title: `${r.toolName} — ${r.plan} plan`,
    priceMinor: r.planPriceMinor,
    currency: r.planCurrency,
    merchantId: r.checkoutUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    image: img(`${r.toolName}-plan`),
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
