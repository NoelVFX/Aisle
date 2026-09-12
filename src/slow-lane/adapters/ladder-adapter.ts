/**
 * The click-target ladder as a VendorPurchaseAdapter (aisle-pipeline.md §17, §18).
 *
 *   Tier 1  offers from JSON-LD `Offer` blocks (no clicking, no model), else page text
 *   Tier 2  replay recorded role+name steps for this billing origin
 *   Tier 3  AX-tree candidates → PICKER model returns an index → real click
 *           → promote the steps to a recorded adapter (version++)
 *   Submit  deterministic only: recorded confirm locator or fixed confirm labels,
 *           and only after Gate 1 in the executor. Controls that pay are removed
 *           from the candidate list before a model ever sees it.
 */

import type { ActionCandidate, PageLike } from "../browser.js";
import { DeterministicStepError, type VendorPurchaseAdapter } from "../vendor-adapter.js";
import { PurchaseFailedError } from "../../errors.js";
import { sameOrigin } from "../../policy/policy.js";
import type { PurchaseOffer, PurchaseVerification, Requirement, StagedPurchase } from "../../types.js";
import {
  detectAutoRenew,
  detectBillingPeriod,
  extractBalance,
  extractPrice,
  extractUnits,
  parseOffersFromText,
} from "./generic-vendor-adapter.js";
import type { AdapterRegistry, RecordedAdapter, RecordedStep } from "./recorded-adapter.js";
import type { CandidatePicker } from "../resolver/picker.js";

/** Names of controls that pay. The model never sees these; only deterministic code clicks them. */
export const CONFIRM_NAME_RE =
  /^\s*(complete (purchase|order|payment)|place (order|payment)|pay( now)?|confirm (purchase|payment|and pay|order)|buy now|submit (payment|order)|purchase|pay \$?[\d.,]+)\s*$/i;

const CONFIRM_LABELS = [
  "Complete purchase",
  "Complete order",
  "Complete payment",
  "Place order",
  "Pay now",
  "Pay",
  "Confirm purchase",
  "Confirm payment",
  "Confirm and pay",
  "Buy now",
  "Submit payment",
];

const FILLABLE = new Set(["textbox", "spinbutton", "searchbox"]);

export interface LadderAdapterConfig {
  provider: string;
  /** Locked billing origin from config. */
  billingOrigin: string;
  pricingPath?: string;
  accountPath?: string;
  /** Any non-empty match means logged in (e.g. "[data-account-email]"). */
  loggedInSelector?: string;
  /** Pathname pattern of the vendor's login wall. */
  loginWallPattern?: RegExp;
  currency?: string;
  registry: AdapterRegistry;
  picker?: CandidatePicker;
  /** Tier-3 steps allowed to reach checkout. Default 4. */
  maxStagingSteps?: number;
  onEvent?: (type: string, detail: Record<string, unknown>) => void;
}

/** Tier 1: schema.org Offer / Product JSON-LD → offers. */
export function offersFromJsonLd(blocks: unknown[], currency = "USD"): PurchaseOffer[] {
  const items: Array<Record<string, unknown>> = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o["@graph"])) visit(o["@graph"]);
    const t = o["@type"];
    const types = (Array.isArray(t) ? t : [t]).map((x) => String(x ?? ""));
    if (types.includes("Offer")) {
      items.push(o);
    } else if (types.includes("Product") && o["offers"]) {
      for (const off of Array.isArray(o["offers"]) ? o["offers"] : [o["offers"]]) {
        if (off && typeof off === "object") items.push({ name: o["name"], sku: o["sku"], ...(off as Record<string, unknown>) });
      }
    }
  };
  visit(blocks);

  const offers: PurchaseOffer[] = [];
  for (const it of items) {
    const price = Number(it["price"]);
    if (!Number.isFinite(price)) continue;
    const name = String(it["name"] ?? "");
    const eq = it["eligibleQuantity"];
    const units =
      typeof eq === "number" ? eq : eq && typeof eq === "object" ? Number((eq as Record<string, unknown>)["value"]) : extractUnits(name);
    if (units === undefined || !Number.isFinite(units) || units <= 0) continue;
    const spec = JSON.stringify(it["priceSpecification"] ?? "");
    const billing: PurchaseOffer["billing"] =
      /billingDuration|billingIncrement|"unitCode":"(MON|ANN)"/i.test(spec) || /subscription|monthly|per month|\/mo/i.test(name)
        ? "subscription"
        : "one_time";
    offers.push({
      productId: String(it["sku"] ?? it["productID"] ?? it["@id"] ?? `ld_${units}_${price}`),
      label: name || `${units} units`,
      unitsGranted: units,
      price,
      currency: String(it["priceCurrency"] ?? currency),
      billing,
      autoRenew: billing === "subscription",
    });
  }
  return offers.sort((a, b) => a.price - b.price);
}

export class LadderVendorAdapter implements VendorPurchaseAdapter {
  private readonly pricingPath: string;
  private readonly accountPath: string;
  private readonly currency: string;
  private readonly maxSteps: number;
  private readonly loginWall: RegExp;

  constructor(private readonly cfg: LadderAdapterConfig) {
    this.pricingPath = cfg.pricingPath ?? "/pricing";
    this.accountPath = cfg.accountPath ?? "/account";
    this.currency = cfg.currency ?? "USD";
    this.maxSteps = cfg.maxStagingSteps ?? 4;
    this.loginWall = cfg.loginWallPattern ?? /^\/(login|log-in|signin|sign-in|auth)\b/i;
  }

  get provider(): string {
    return this.cfg.provider;
  }

  private url(path: string): string {
    return new URL(path, this.cfg.billingOrigin).toString();
  }

  private emit(type: string, detail: Record<string, unknown> = {}): void {
    this.cfg.onEvent?.(type, detail);
  }

  private async first(page: PageLike, selector: string): Promise<string | undefined> {
    return (await page.queryAllText(selector)).map((t) => t.trim()).find((t) => t.length > 0);
  }

  private offerKey(offer: PurchaseOffer): string {
    return `units:${offer.unitsGranted}`;
  }

  canHandle(url: string): boolean {
    return sameOrigin(url, this.cfg.billingOrigin);
  }

  async ensureLoggedIn(page: PageLike): Promise<boolean> {
    await page.goto(this.url(this.accountPath));
    await page.settle?.(3000); // client-side login redirects land after load
    const here = new URL(page.currentUrl());
    if (!sameOrigin(here.origin, this.cfg.billingOrigin) || this.loginWall.test(here.pathname)) return false;
    if (this.cfg.loggedInSelector) return (await this.first(page, this.cfg.loggedInSelector)) !== undefined;
    return true;
  }

  async discoverOffers(page: PageLike, _requirement: Requirement): Promise<PurchaseOffer[]> {
    await page.goto(this.url(this.pricingPath));
    await page.settle?.(1500);
    let offers: PurchaseOffer[] = [];
    if (page.jsonLd) {
      offers = offersFromJsonLd(await page.jsonLd(), this.currency);
      if (offers.length > 0) this.emit("OFFERS_FROM_JSON_LD", { count: offers.length });
    }
    if (offers.length === 0) offers = parseOffersFromText(await page.innerText(), { currency: this.currency });
    if (offers.length === 0) {
      throw new DeterministicStepError(
        "No offers found on the pricing page.",
        "Open the pricing page and make the purchasable packages visible. Do not buy anything.",
      );
    }
    return offers;
  }

  async stagePurchase(page: PageLike, offer: PurchaseOffer): Promise<StagedPurchase> {
    const key = this.offerKey(offer);
    const recorded = await this.cfg.registry.load(this.cfg.billingOrigin);
    const steps = recorded?.offers[key];

    let staged = false;
    if (recorded && steps && steps.length > 0) {
      this.emit("ADAPTER_REPLAY", { tier: 2, version: recorded.version, steps: steps.length });
      staged = await this.replay(page, steps, offer);
      if (!staged) this.emit("ADAPTER_MISS", { tier: 2, version: recorded.version });
    }

    if (!staged) {
      await page.goto(this.url(this.pricingPath));
      await page.settle?.(1500);
      const newSteps = await this.resolveCold(page, offer);
      // The fallback is the recording mechanism: promote tier 3 to tier 2.
      const latest = await this.cfg.registry.load(this.cfg.billingOrigin);
      const next: RecordedAdapter = {
        billingOrigin: this.cfg.billingOrigin,
        version: (latest?.version ?? 0) + 1,
        offers: { ...(latest?.offers ?? {}), [key]: newSteps },
        ...(latest?.confirm ? { confirm: latest.confirm } : {}),
        updatedAt: new Date().toISOString(),
      };
      await this.cfg.registry.save(next);
      this.emit("ADAPTER_RECORDED", { version: next.version, package: key, steps: newSteps.length });
    }

    return this.readStaged(page, offer);
  }

  private async replay(page: PageLike, steps: RecordedStep[], offer: PurchaseOffer): Promise<boolean> {
    if (!page.clickByRole) return false;
    for (const step of steps) {
      const ok =
        step.action === "fill"
          ? page.fillByRole
            ? await page.fillByRole(step.role, step.name, String(offer.price))
            : false
          : await page.clickByRole(step.role, step.name);
      if (!ok) return false;
      await page.settle?.(1200);
    }
    return this.checkoutReady(page);
  }

  private async resolveCold(page: PageLike, offer: PurchaseOffer): Promise<RecordedStep[]> {
    if (!this.cfg.picker || !page.actionableCandidates || !page.clickCandidate) {
      throw new DeterministicStepError(
        "No recorded adapter for this package and no tier-3 resolver available.",
        `Select the '${offer.label}' package and continue to the checkout. Do not pay.`,
      );
    }
    const recorded: RecordedStep[] = [];
    for (let step = 0; step < this.maxSteps; step++) {
      if (await this.checkoutReady(page)) return recorded;

      const candidates: ActionCandidate[] = (await page.actionableCandidates())
        .filter((c) => !CONFIRM_NAME_RE.test(c.name))
        .map((c, index) => ({ ...c, index }));
      if (candidates.length === 0) break;

      const goal =
        `Buy exactly this package: "${offer.label}" (${offer.unitsGranted} units for ${offer.currency} ${offer.price}, one-time). ` +
        `Step ${step + 1}: choose the ONE control that moves toward the checkout for this package. ` +
        `If a field asks for the amount, choose that field; the amount is typed for you.`;
      const pick = await this.cfg.picker.pick({
        goal,
        candidates,
        stepKey: `${this.cfg.billingOrigin}|${this.offerKey(offer)}|${step}`,
      });
      const chosen = candidates[pick.index]!;
      this.emit("RESOLVER_CALLED", {
        tier: 3,
        profile: "PICKER",
        step: step + 1,
        role: chosen.role,
        name: chosen.name,
        why: pick.why,
        model: pick.modelUsed,
        replayed: pick.replayed,
      });

      if (FILLABLE.has(chosen.role) && page.fillCandidate) {
        await page.fillCandidate(chosen, String(offer.price));
        recorded.push({ action: "fill", role: chosen.role, name: chosen.name, value: "{price}" });
      } else {
        await page.clickCandidate(chosen);
        recorded.push({ action: "click", role: chosen.role, name: chosen.name });
      }
      await page.settle?.(1500);
    }
    if (await this.checkoutReady(page)) return recorded;
    throw new DeterministicStepError(
      `Checkout not reached after ${this.maxSteps} resolver steps.`,
      `Open the checkout for '${offer.label}'. Do not pay.`,
    );
  }

  private async checkoutReady(page: PageLike): Promise<boolean> {
    if ((await page.queryAllText("[data-checkout-amount]")).length > 0) return true;
    const buttons = await page.queryAllText('button, [role="button"], input[type="submit"]');
    if (!buttons.some((b) => CONFIRM_NAME_RE.test(b))) return false;
    return extractPrice(await page.innerText()) !== undefined;
  }

  private async readStaged(page: PageLike, offer: PurchaseOffer): Promise<StagedPurchase> {
    const text = await page.innerText();
    const rawAmount = await this.first(page, "[data-checkout-amount]");
    const amount = rawAmount !== undefined ? Number(rawAmount.replace(/[^0-9.]/g, "")) : extractPrice(text);
    if (amount === undefined || !Number.isFinite(amount)) {
      throw new DeterministicStepError("Checkout total not readable.", "Open the checkout so the order total is visible. Do not pay.");
    }

    const rawLine = await this.first(page, "[data-checkout-line]");
    const lineItem = rawLine ?? offer.label;
    const lineUnits = rawLine === undefined ? undefined : extractUnits(rawLine);
    if (lineUnits !== undefined && lineUnits !== offer.unitsGranted) {
      throw new PurchaseFailedError(
        `Checkout line item grants ${lineUnits} units; the selected package grants ${offer.unitsGranted}. Aborting before submit.`,
        "LINE_ITEM_MISMATCH",
      );
    }

    const period = await this.first(page, "[data-checkout-period]");
    const renew = await this.first(page, "[data-checkout-autorenew]");
    const currency = await this.first(page, "[data-checkout-currency]");
    return {
      offer,
      checkoutRef: page.currentUrl(),
      lineItem,
      amount,
      currency: currency ?? this.currency,
      // Anything other than an explicit one_time fails closed as a subscription.
      billingPeriod: period !== undefined ? (period === "one_time" ? "one_time" : "subscription") : detectBillingPeriod(text),
      autoRenew: renew !== undefined ? renew !== "false" : detectAutoRenew(text),
    };
  }

  async confirmPurchase(page: PageLike, _staged: StagedPurchase): Promise<PurchaseVerification> {
    const recorded = await this.cfg.registry.load(this.cfg.billingOrigin);
    let clicked: { role: string; name: string } | undefined;

    if (recorded?.confirm && page.clickByRole && (await page.clickByRole(recorded.confirm.role, recorded.confirm.name))) {
      clicked = recorded.confirm;
    }
    if (!clicked) {
      for (const label of CONFIRM_LABELS) {
        const ok = page.clickByRole ? await page.clickByRole("button", label) : await page.tryClickByText(label);
        if (ok) {
          clicked = { role: "button", name: label };
          break;
        }
      }
    }
    if (!clicked) {
      throw new DeterministicStepError("Confirm control not found.", "Confirm control not found. The final submit is never delegated to a model.");
    }
    this.emit("CONFIRM_CLICKED", { role: clicked.role, name: clicked.name, deterministic: true });

    if (recorded?.confirm?.name !== clicked.name) {
      try {
        const latest = await this.cfg.registry.load(this.cfg.billingOrigin);
        await this.cfg.registry.save({
          billingOrigin: this.cfg.billingOrigin,
          version: (latest?.version ?? 0) + 1,
          offers: latest?.offers ?? {},
          confirm: clicked,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // Recording is best effort. The click already happened; never turn it into an error here.
      }
    }

    await page.settle?.(2500);
    const tx = await this.first(page, "[data-transaction-id]");
    return tx === undefined ? { confirmed: true } : { confirmed: true, transactionId: tx };
  }

  async verifyEntitlement(page: PageLike, requirement: Requirement): Promise<PurchaseVerification> {
    await page.goto(this.url(this.accountPath));
    await page.settle?.(2000);
    const raw = await this.first(page, "[data-balance]");
    const parsed = raw !== undefined ? Number(raw.replace(/[^0-9.-]/g, "")) : extractBalance(await page.innerText());
    const balance = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
    const out: PurchaseVerification = { confirmed: balance !== undefined && balance >= requirement.amount, resource: requirement.resource };
    if (balance !== undefined) out.balanceAfter = balance;
    const tx = await this.first(page, "[data-last-transaction-id]");
    if (tx) out.transactionId = tx;
    return out;
  }
}
