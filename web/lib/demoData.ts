import type { Tone, ToolRec } from "./types";

/**
 * Physical products are NOT defined here anymore. They come live from Agnic's Shopify
 * catalogue (see lib/agnic.ts). This file only holds SaaS tool recommendations, which are
 * a discovery layer (not Shopify catalogue products), plus formatting helpers.
 */

export const TOOL_RECS: Record<string, ToolRec> = {
  email: { toolName: "Resend", category: "Transactional email API", checkoutUrl: "https://resend.com/pricing", plan: "Pro", why: "Developer-first email with an official MCP server and clean React email support.", alternatives: [{ toolName: "Postmark", why: "Rock-solid deliverability" }, { toolName: "Loops", why: "Marketing plus transactional" }], hasMcp: true, buySku: "saas:resend-pro", planPriceMinor: 2000, planCurrency: "USD" },
  payments: { toolName: "Stripe", category: "Payments and billing", checkoutUrl: "https://stripe.com/pricing", plan: "Standard", why: "The default rails for card, subscription, and usage billing, with strong tooling.", alternatives: [{ toolName: "Paddle", why: "Merchant of record" }, { toolName: "Lemon Squeezy", why: "Simple for indie" }], hasMcp: true, buySku: "saas:stripe-standard", planPriceMinor: 0, planCurrency: "USD" },
  search: { toolName: "Algolia", category: "Hosted search", checkoutUrl: "https://www.algolia.com/pricing", plan: "Grow", why: "Instant, typo-tolerant search with generous limits and a mature API.", alternatives: [{ toolName: "Typesense", why: "Open source, self-host" }, { toolName: "Meilisearch", why: "Fast to set up" }], hasMcp: false, buySku: "saas:algolia-grow", planPriceMinor: 5000, planCurrency: "USD" },
};

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
