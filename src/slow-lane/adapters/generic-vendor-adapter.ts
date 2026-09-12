/**
 * Generic vendor adapter — one adapter for MOST vendor sites.
 *
 * The whole point of the fast/slow design is that we don't hand-write a class
 * per vendor. This adapter uses site-agnostic heuristics for the predictable
 * majority — guess the pricing/billing paths, read prices and unit counts out of
 * the page text, click buy/confirm controls by common labels, read the balance
 * back — and throws `DeterministicStepError` the moment a step is ambiguous, so
 * the worker hands that sub-goal to the host-injected computer-use agent. Easy
 * sites go fast and cheap; hard ones (canvas, closed shadow DOM, odd layouts)
 * fall through to the model. Tune a vendor by passing config, not new code.
 *
 * Only the parsing heuristics live here; the pure functions are exported so they
 * can be unit-tested without a browser.
 */

import type { PageLike } from "../browser.js";
import {
  DeterministicStepError,
  type VendorPurchaseAdapter,
} from "../vendor-adapter.js";
import type {
  PurchaseOffer,
  PurchaseVerification,
  Requirement,
  StagedPurchase,
} from "../../types.js";

export interface GenericAdapterConfig {
  provider: string;
  /** Canonical vendor origin (same as the mandate origin). */
  origin: string;
  /** Paths to try for the pricing/packages page. */
  pricingPaths?: string[];
  /** Paths to try when reading the balance back. */
  accountPaths?: string[];
  /** Candidate labels for "select this package / buy" controls. */
  buyButtonTexts?: string[];
  /** Candidate labels for the final confirm/pay control. */
  confirmButtonTexts?: string[];
  /** Matches a price like `$20` or `$19.99`; capture group 1 is the number. */
  priceRegex?: RegExp;
  /** Matches `5,000 credits` / `5000 tokens`; capture group 1 is the amount. */
  unitsRegex?: RegExp;
  currency?: string;
}

const DEFAULTS = {
  pricingPaths: ["/pricing", "/billing", "/plans", "/credits", "/account/billing", "/settings/billing"],
  accountPaths: ["/account", "/billing", "/dashboard", "/settings/billing", "/account/usage"],
  buyButtonTexts: ["Buy", "Purchase", "Select", "Choose", "Get", "Subscribe", "Upgrade", "Add credits", "Top up", "Top-up"],
  confirmButtonTexts: ["Pay", "Confirm", "Place order", "Complete purchase", "Complete order", "Buy now", "Authorize", "Checkout"],
  priceRegex: /\$\s?(\d+(?:\.\d{1,2})?)/,
  unitsRegex: /([\d,]+)\s*(?:credits?|tokens?|units?|generations?)/i,
  currency: "USD",
};

const num = (s: string): number => Number(s.replace(/,/g, ""));

/** First price found in a text blob, or undefined. */
export function extractPrice(text: string, priceRegex = DEFAULTS.priceRegex): number | undefined {
  const m = priceRegex.exec(text);
  return m?.[1] === undefined ? undefined : num(m[1]);
}

/** First unit count found in a text blob, or undefined. */
export function extractUnits(text: string, unitsRegex = DEFAULTS.unitsRegex): number | undefined {
  const m = unitsRegex.exec(text);
  return m?.[1] === undefined ? undefined : num(m[1]);
}

/**
 * Parse purchasable offers out of a page's visible text, one candidate per line
 * that carries both a price and a unit count. Synthesizes a stable productId
 * from units+price. Pure — unit-testable without a browser.
 */
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
    offers.push({ productId, label: line, units, price, currency, billing: "one_time" });
  }
  return offers.sort((a, b) => a.price - b.price);
}

export class GenericVendorAdapter implements VendorPurchaseAdapter {
  private readonly cfg: Required<GenericAdapterConfig>;

  constructor(cfg: GenericAdapterConfig) {
    this.cfg = {
      pricingPaths: DEFAULTS.pricingPaths,
      accountPaths: DEFAULTS.accountPaths,
      buyButtonTexts: DEFAULTS.buyButtonTexts,
      confirmButtonTexts: DEFAULTS.confirmButtonTexts,
      priceRegex: DEFAULTS.priceRegex,
      unitsRegex: DEFAULTS.unitsRegex,
      currency: DEFAULTS.currency,
      ...cfg,
    };
  }

  get provider(): string {
    return this.cfg.provider;
  }

  canHandle(url: string): boolean {
    return this.cfg.origin === "*" || url.startsWith(this.cfg.origin);
  }

  async discoverOffers(page: PageLike, _requirement: Requirement): Promise<PurchaseOffer[]> {
    for (const path of this.cfg.pricingPaths) {
      await page.goto(this.cfg.origin + path);
      const offers = parseOffersFromText(await page.innerText(), this.cfg);
      if (offers.length > 0) return offers;
    }
    throw new DeterministicStepError(
      "No pricing packages found via known paths.",
      "Navigate to the vendor's pricing or billing page and make the purchasable credit packages visible.",
    );
  }

  async stagePurchase(page: PageLike, offer: PurchaseOffer): Promise<StagedPurchase> {
    const candidates = [offer.label, ...this.cfg.buyButtonTexts];
    let clicked = false;
    for (const label of candidates) {
      if (await page.tryClickByText(label)) {
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      throw new DeterministicStepError(
        "Could not select the chosen package.",
        `Select the package labelled '${offer.label}' and continue to the checkout page.`,
      );
    }
    const total = extractPrice(await page.innerText(), this.cfg.priceRegex);
    if (total === undefined) {
      throw new DeterministicStepError(
        "Checkout total not visible.",
        "Open the checkout page so the order total is shown.",
      );
    }
    return {
      offer,
      checkoutRef: page.currentUrl(),
      observedTotal: total,
      observedCurrency: this.cfg.currency,
    };
  }

  async confirmPurchase(page: PageLike, _staged: StagedPurchase): Promise<PurchaseVerification> {
    for (const label of this.cfg.confirmButtonTexts) {
      if (await page.tryClickByText(label)) {
        return { confirmed: true };
      }
    }
    throw new DeterministicStepError(
      "Could not find a confirm/pay control.",
      "Click the final Pay/Confirm button to complete the already-authorized purchase. Do not change any amount or product.",
    );
  }

  async verifyEntitlement(page: PageLike, requirement: Requirement): Promise<PurchaseVerification> {
    for (const path of this.cfg.accountPaths) {
      await page.goto(this.cfg.origin + path);
      const balance = extractUnits(await page.innerText(), this.cfg.unitsRegex);
      if (balance !== undefined) {
        return {
          confirmed: balance >= requirement.amount,
          balanceAfter: balance,
          resource: requirement.resource,
          accountId: "unknown",
        };
      }
    }
    // Safe failure: better to fail verification than to falsely resume the task.
    return {
      confirmed: false,
      reason: "Could not read an authoritative balance from the account pages.",
    };
  }
}
