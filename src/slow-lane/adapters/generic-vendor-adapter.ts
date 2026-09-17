/**
 * Generic vendor adapter — one adapter for most vendor sites.
 *
 * Site-agnostic heuristics for the predictable majority: guess the pricing and
 * account paths, read prices and unit counts out of the page text, click the
 * CHOSEN package by its own label, read the staged checkout back for Gate 1, and
 * read the balance from a line that actually says "balance". The moment a step is
 * ambiguous it throws `DeterministicStepError` so the worker can hand discovery
 * or staging to the resolver. Ambiguity at confirm or verification fails closed.
 *
 * The docs prefer structured inputs where available (JSON-LD `Offer`, Browser
 * Tools markdown, §13/§17 tier 1). This text heuristic is the fallback.
 */

import type { PageLike } from "../browser.js";
import { DeterministicStepError, type VendorPurchaseAdapter } from "../vendor-adapter.js";
import { PurchaseFailedError } from "../../errors.js";
import type { PurchaseOffer, PurchaseVerification, Requirement, StagedPurchase } from "../../types.js";

export interface GenericAdapterConfig {
  provider: string;
  /** Locked billing origin (same as checkpoint.origin.billingOrigin). */
  origin: string;
  pricingPaths?: string[];
  accountPaths?: string[];
  /** Candidate labels for the final confirm/pay control. */
  confirmButtonTexts?: string[];
  /** Matches a price like `$20` or `$19.99`; capture group 1 is the number. */
  priceRegex?: RegExp;
  /** Matches `5,000 credits`; capture group 1 is the amount. */
  unitsRegex?: RegExp;
  /** A line that states the current balance. */
  balanceLineRegex?: RegExp;
  currency?: string;
}

const DEFAULTS = {
  pricingPaths: ["/pricing", "/billing", "/plans", "/credits", "/account/billing", "/settings/billing"],
  accountPaths: ["/account", "/billing", "/dashboard", "/settings/billing", "/account/usage"],
  confirmButtonTexts: ["Complete purchase", "Complete order", "Place order", "Pay", "Confirm", "Buy now", "Authorize"],
  priceRegex: /\$\s?(\d+(?:\.\d{1,2})?)/,
  unitsRegex: /([\d,]+)\s*(?:credits?|tokens?|units?|generations?)/i,
  balanceLineRegex: /\b(balance|remaining|available|left)\b/i,
  currency: "USD",
};

const SUBSCRIPTION_RE = /(\/\s*(mo|month|yr|year)\b|per\s+(month|year)|monthly|yearly|annual(ly)?|subscription|recurring)/i;
const AUTO_RENEW_ON_RE = /(auto[- ]?renew(s|al)?\s*[:=]?\s*(on|enabled|yes|true)|renews automatically)/i;
const AUTO_RENEW_OFF_RE = /(no auto[- ]?renew|auto[- ]?renew(s|al)?\s*[:=]?\s*(off|disabled|no|false))/i;

const num = (s: string): number => Number(s.replace(/,/g, ""));

export function extractPrice(text: string, priceRegex = DEFAULTS.priceRegex): number | undefined {
  // Skip conversion-RATE tokens, not prices: "$1 = 21 credits", "$1/credit".
  // A "$N" immediately followed by "=" or "/" is a rate and must not be read as a total.
  const g = new RegExp(priceRegex.source, priceRegex.flags.includes("g") ? priceRegex.flags : priceRegex.flags + "g");
  for (const m of text.matchAll(g)) {
    if (m[1] === undefined) continue;
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 16);
    if (/^\s*=/.test(after)) continue; // conversion rate: "$1 = 21 credits" (but keep "$10/month")
    return num(m[1]);
  }
  return undefined;
}

export function extractUnits(text: string, unitsRegex = DEFAULTS.unitsRegex): number | undefined {
  const m = unitsRegex.exec(text);
  return m?.[1] === undefined ? undefined : num(m[1]);
}

export function detectBillingPeriod(text: string): "one_time" | "subscription" {
  return SUBSCRIPTION_RE.test(text) ? "subscription" : "one_time";
}

export function detectAutoRenew(text: string): boolean {
  if (AUTO_RENEW_OFF_RE.test(text)) return false;
  return AUTO_RENEW_ON_RE.test(text);
}

/** Balance from a line that names it, never from the first "N credits" on the page. */
export function extractBalance(
  text: string,
  unitsRegex = DEFAULTS.unitsRegex,
  balanceLineRegex = DEFAULTS.balanceLineRegex,
): number | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!balanceLineRegex.test(line)) continue;
    const units = extractUnits(line, unitsRegex);
    if (units !== undefined) return units;
    const bare = /(-?[\d,]+(?:\.\d+)?)/.exec(line.replace(balanceLineRegex, ""));
    if (bare?.[1] !== undefined) return num(bare[1]);
  }
  return undefined;
}

/** Offers from visible text, one per line carrying both a price and a unit count. */
export function parseOffersFromText(
  text: string,
  cfg: Pick<GenericAdapterConfig, "priceRegex" | "unitsRegex" | "currency"> = {},
): PurchaseOffer[] {
  const priceRegex = cfg.priceRegex ?? DEFAULTS.priceRegex;
  const unitsRegex = cfg.unitsRegex ?? DEFAULTS.unitsRegex;
  const currency = cfg.currency ?? DEFAULTS.currency;

  const seen = new Set<string>();
  const offers: PurchaseOffer[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const price = extractPrice(line, priceRegex);
    const units = extractUnits(line, unitsRegex);
    if (price === undefined || units === undefined) continue;
    const productId = `gen_${units}_${price}`;
    if (seen.has(productId)) continue;
    seen.add(productId);
    offers.push({
      productId,
      label: line,
      unitsGranted: units,
      price,
      currency,
      billing: detectBillingPeriod(line),
      autoRenew: detectAutoRenew(line),
    });
  }
  return offers.sort((a, b) => a.price - b.price);
}

export class GenericVendorAdapter implements VendorPurchaseAdapter {
  private readonly cfg: Required<GenericAdapterConfig>;

  constructor(cfg: GenericAdapterConfig) {
    this.cfg = {
      pricingPaths: DEFAULTS.pricingPaths,
      accountPaths: DEFAULTS.accountPaths,
      confirmButtonTexts: DEFAULTS.confirmButtonTexts,
      priceRegex: DEFAULTS.priceRegex,
      unitsRegex: DEFAULTS.unitsRegex,
      balanceLineRegex: DEFAULTS.balanceLineRegex,
      currency: DEFAULTS.currency,
      ...cfg,
    };
  }

  get provider(): string {
    return this.cfg.provider;
  }

  canHandle(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.cfg.origin).origin;
    } catch {
      return false;
    }
  }

  async discoverOffers(page: PageLike, _requirement: Requirement): Promise<PurchaseOffer[]> {
    for (const path of this.cfg.pricingPaths) {
      await page.goto(this.cfg.origin + path);
      const offers = parseOffersFromText(await page.innerText(), this.cfg);
      if (offers.length > 0) return offers;
    }
    throw new DeterministicStepError(
      "No pricing packages found via known paths.",
      "Navigate to the vendor's pricing or billing page and make the purchasable credit packages visible. Do not buy anything.",
    );
  }

  async stagePurchase(page: PageLike, offer: PurchaseOffer): Promise<StagedPurchase> {
    // Only controls that identify THIS package. A generic "Buy" could be any package.
    const labels = [offer.label, `${offer.unitsGranted.toLocaleString("en-US")} credits`, `${offer.unitsGranted} credits`];
    let clicked = false;
    for (const label of labels) {
      if (await page.tryClickByText(label)) {
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      throw new DeterministicStepError(
        "Could not select the chosen package.",
        `Select the package labelled '${offer.label}' and continue to the checkout page. Do not pay.`,
      );
    }

    const text = await page.innerText();
    const amount = extractPrice(text, this.cfg.priceRegex);
    if (amount === undefined) {
      throw new DeterministicStepError("Checkout total not visible.", "Open the checkout page so the order total is shown. Do not pay.");
    }
    const stagedUnits = extractUnits(text, this.cfg.unitsRegex);
    if (stagedUnits !== undefined && stagedUnits !== offer.unitsGranted) {
      throw new PurchaseFailedError(
        `Checkout shows ${stagedUnits} units but the selected package grants ${offer.unitsGranted}. Aborting before submit.`,
        "LINE_ITEM_MISMATCH",
      );
    }
    return {
      offer,
      checkoutRef: page.currentUrl(),
      lineItem: offer.label,
      amount,
      currency: this.cfg.currency,
      billingPeriod: detectBillingPeriod(text),
      autoRenew: detectAutoRenew(text),
    };
  }

  async confirmPurchase(page: PageLike, _staged: StagedPurchase): Promise<PurchaseVerification> {
    for (const label of this.cfg.confirmButtonTexts) {
      if (await page.tryClickByText(label)) return { confirmed: true };
    }
    throw new DeterministicStepError(
      "Could not find a confirm/pay control.",
      "Confirm control not found. The final submit is never delegated to a model.",
    );
  }

  async verifyEntitlement(page: PageLike, requirement: Requirement): Promise<PurchaseVerification> {
    for (const path of this.cfg.accountPaths) {
      await page.goto(this.cfg.origin + path);
      const balance = extractBalance(await page.innerText(), this.cfg.unitsRegex, this.cfg.balanceLineRegex);
      if (balance !== undefined) {
        return { confirmed: balance >= requirement.amount, balanceAfter: balance, resource: requirement.resource };
      }
    }
    // Safe failure: better to fail verification than to falsely resume the task.
    return { confirmed: false, reason: "Could not read an authoritative balance from the account pages." };
  }
}
