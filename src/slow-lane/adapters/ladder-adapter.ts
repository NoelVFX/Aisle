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
import { PurchaseFailedError, TakeoverRequiredError } from "../../errors.js";
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
  "Purchase",
  "Confirm purchase",
  "Confirm payment",
  "Confirm and pay",
  "Buy now",
  "Submit payment",
];

const FILLABLE = new Set(["textbox", "spinbutton", "searchbox"]);

/** Checkout challenges a human must clear (steel.md §16.3). Never automated. */
const CHALLENGE_TEXT_RE =
  /3-?D ?Secure|verify (it'?s|that it'?s) you|authenticate (this|your) (payment|purchase)|one-time (pass)?code|enter the (verification )?code|confirm (this|the) (payment|purchase) in your (bank|banking app)/i;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Reveal-and-read retries per account page before giving up on a menu-hidden balance. */
const BALANCE_READ_ATTEMPTS = 3;

/**
 * Account setup the user owns: a billing address or a first payment method. Aisle
 * never invents identity or card details, and never lets a model try (seen live on
 * OpenRouter: "A billing address is required to verify your identity").
 */
const ACCOUNT_SETUP_TEXT_RE =
  /billing address is required|add a billing address|add a payment method to (continue|purchase)|no payment method on file|save payment method/i;
/** Controls that start that setup. Never offered to the picker. */
const ACCOUNT_SETUP_CONTROL_RE = /billing address|payment method|address details|add (a )?card/i;
/** The amount box of a typed-amount top-up, e.g. OpenRouter's spinbutton "(5 - 25000)" next to "Amount". */
const AMOUNT_FIELD_RE = /amount|\(\s*\d+\s*[-–]\s*\d+\s*\)|top.?up/i;

/**
 * The checkout total, preferring a labelled total ("Total due $10.80") over the first
 * price on the page, which is often a fee line ("Service fees $0.80"). The last labelled
 * total wins: the order summary sits below any balance banner.
 */
export function extractCheckoutTotal(text: string): number | undefined {
  const matches = [...text.matchAll(/\b(?:total due|amount due|order total|grand total|total)\b[^\d$€£]{0,20}[$€£]\s?([\d,]+(?:\.\d{1,2})?)/gi)];
  const last = matches.at(-1)?.[1];
  return last === undefined ? undefined : Number(last.replace(/,/g, ""));
}

/** Controls that only dismiss. Clicking them never moves toward a checkout. */
const DISMISS_RE = /^\s*(close|cancel|dismiss|back|not now|no thanks)\s*$/i;

/**
 * Stripe's PUBLIC test card. Only ever typed into a TEST-mode Stripe Checkout
 * Session (cs_test_…), where it cannot move money. Real cards are never handled
 * here: they live on the vendor account or in Steel (aisle-pipeline.md §11).
 */
const STRIPE_TEST_CARD = { number: "4242424242424242", expiry: "1234", cvc: "123", name: "Aisle Demo", postalCode: "94103" } as const;

const CHALLENGE_FRAMES = 'iframe[src*="3d_secure"], iframe[src*="3ds"], iframe[name*="challenge"], iframe[src*="acs"]';

export interface LadderAdapterConfig {
  provider: string;
  /** Locked billing origin from config. */
  billingOrigin: string;
  pricingPath?: string;
  accountPath?: string;
  /** Account paths tried in order for the authoritative pre/post-purchase balance. */
  accountPaths?: string[];
  /** Selectors containing the authoritative balance, before falling back to page text. */
  balanceSelectors?: string[];
  /**
   * A control to click (on the account page, without reloading) to REVEAL the
   * balance when it lives behind a menu — e.g. an account/profile avatar whose
   * dropdown shows "Credits N left". Clicked after navigating, before reading.
   */
  balanceRevealSelector?: string;
  /**
   * Close controls for blocking modals/overlays (promo popups, cookie banners)
   * cleared before the balance read. Escape is always tried first; these are the
   * fallback close buttons — e.g. "[aria-label*='close' i]". Each is bounded and
   * swallowed, so a selector that matches nothing is harmless.
   */
  dismissSelectors?: string[];
  /**
   * Page opened to begin staging when the top-up UI isn't the pricing page.
   * Defaults to `pricingPath`. The avatar/header controls live on every page, so
   * for a dropdown-based top-up the app root ("/") works.
   */
  offerEntryPath?: string;
  /**
   * Controls clicked in order (after overlays are dismissed) to REVEAL the
   * top-up packs before staging — e.g. [profile avatar, the "Top-up credits"
   * button in its dropdown]. Deterministic so the picker doesn't get baited by a
   * promo/upsell instead of the top-up path. Each click is bounded and swallowed.
   */
  offerRevealSelectors?: string[];
  /** Any non-empty match means logged in (e.g. "[data-account-email]"). */
  loggedInSelector?: string;
  /**
   * Any non-empty match (with no logged-in marker) means logged OUT — for vendors
   * that show a marketing page with "Log in / Sign up" controls instead of
   * redirecting to a login wall. E.g. "a[href*='login' i],a[href*='signup' i]".
   */
  loggedOutSelector?: string;
  /** Pathname pattern of the vendor's login wall. */
  loginWallPattern?: RegExp;
  currency?: string;
  /**
   * Packages from the vendor catalogue (upstreams.json). For vendors whose top-up
   * is a typed amount rather than listed packs (e.g. OpenAI API credits), the
   * offer comes from config and the amount is typed into the page, never read
   * from page text.
   */
  catalogueOffers?: PurchaseOffer[];
  registry: AdapterRegistry;
  picker?: CandidatePicker;
  /**
   * Payment-processor origins the checkout may hop to (e.g. https://checkout.stripe.com).
   * From config only. Gate 1 refuses a checkout on any other origin.
   */
  paymentOrigins?: string[];
  /** Stripe TEST mode only: type Stripe's public test card when Checkout shows no saved card. */
  stripeTestCard?: boolean;
  /** Vendor balance API. When set, the liveness-independent balance reads (and Gate 2) use it. */
  balanceReader?: () => Promise<number | undefined>;
  /** After submit, how long Gate 2 waits for the API balance to move. Default 45s. */
  balanceSettleMs?: number;
  /** Steel's credentials vault may be signing in: wait this long on the login wall first. Default 0. */
  loginGraceMs?: number;
  /** Tier-3 steps allowed to reach checkout. Default 4. */
  maxStagingSteps?: number;
  /**
   * Controls whose accessible name matches this are removed from the picker's
   * candidates — subscription/plan upsells that would derail a one-time credit
   * top-up (e.g. "Explore all plans", "Upgrade", "% OFF"). Per vendor, so it
   * never hides the buy path on a plan-based vendor.
   */
  excludeControlsRegex?: RegExp;
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
  private readonly accountPaths: string[];
  private readonly balanceSelectors: string[];
  private readonly currency: string;
  private readonly maxSteps: number;
  private readonly loginWall: RegExp;
  private awaitingCredit = false;
  private lastApiBalance: number | undefined;

  constructor(private readonly cfg: LadderAdapterConfig) {
    this.pricingPath = cfg.pricingPath ?? "/pricing";
    this.accountPath = cfg.accountPath ?? "/account";
    this.accountPaths = [...new Set([this.accountPath, ...(cfg.accountPaths ?? [])])];
    this.balanceSelectors = [
      "[data-balance]",
      '[data-testid*="balance" i]',
      '[data-testid*="credit" i]',
      '[aria-label*="balance" i]',
      '[aria-label*="credit" i]',
      ...(cfg.balanceSelectors ?? []),
    ];
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

  onLoginWall(url: string): boolean {
    try {
      const here = new URL(url);
      return !sameOrigin(here.origin, this.cfg.billingOrigin) || this.loginWall.test(here.pathname);
    } catch {
      return false;
    }
  }

  async challengeCleared(page: PageLike): Promise<boolean> {
    return !(await this.challengePresent(page));
  }

  private async challengePresent(page: PageLike): Promise<boolean> {
    if ((await page.queryAllText(CHALLENGE_FRAMES).catch(() => [])).length > 0) return true;
    return CHALLENGE_TEXT_RE.test(await page.innerText().catch(() => ""));
  }

  async ensureLoggedIn(page: PageLike): Promise<boolean> {
    await page.goto(this.url(this.accountPath));
    await page.settle?.(3000); // client-side login redirects land after load
    // Steel's credentials vault may be signing in right now (steel.md §8).
    for (let waited = 0; this.onLoginWall(page.currentUrl()) && waited < (this.cfg.loginGraceMs ?? 0); waited += 1000) {
      await page.settle?.(1000);
    }
    if (this.onLoginWall(page.currentUrl())) return false;
    // Some vendors never redirect to a login wall — a logged-out visitor just
    // sees the marketing page with "Log in / Sign up" controls. A visible
    // logged-out marker (and no logged-in marker) is a reliable negative, so we
    // detect the logout and hand off to an interactive login instead of quoting
    // a purchase against a balance of 0.
    if (this.cfg.loggedOutSelector) {
      await page.dismissOverlays?.(this.cfg.dismissSelectors ?? []).catch(() => {});
      const loggedOut = (await this.first(page, this.cfg.loggedOutSelector)) !== undefined;
      const loggedIn = this.cfg.loggedInSelector ? (await this.first(page, this.cfg.loggedInSelector)) !== undefined : false;
      if (loggedOut && !loggedIn) return false;
    }
    if (this.cfg.loggedInSelector) return (await this.first(page, this.cfg.loggedInSelector)) !== undefined;
    return true;
  }

  async discoverOffers(page: PageLike, _requirement: Requirement): Promise<PurchaseOffer[]> {
    await page.goto(this.url(this.pricingPath));
    await page.settle?.(1500);
    if (this.cfg.catalogueOffers && this.cfg.catalogueOffers.length > 0) {
      this.emit("OFFERS_FROM_CATALOGUE", { count: this.cfg.catalogueOffers.length });
      return [...this.cfg.catalogueOffers];
    }
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
      // Recorded steps begin from the open offer surface (e.g. the avatar
      // dropdown), so reveal it before replaying too.
      await this.openOfferSurface(page);
      this.emit("ADAPTER_REPLAY", { tier: 2, version: recorded.version, steps: steps.length });
      staged = await this.replay(page, steps, offer);
      if (staged) {
        // A recording can go stale (the vendor's flow changed) and land on the
        // wrong checkout — a total below the package price. Drop the stale steps
        // so the NEXT run re-resolves cold, but never proceed on this run: the
        // shared readStaged below still aborts (safety over convenience).
        await this.waitForCheckout(page);
        const total = await this.peekCheckoutTotal(page);
        if (total === undefined || total + 0.005 < offer.price) {
          this.emit("ADAPTER_STALE", { version: recorded.version, total: total ?? null, package: key });
          await this.invalidateRecording(recorded, key);
        }
      } else {
        this.emit("ADAPTER_MISS", { tier: 2, version: recorded.version });
      }
    }

    if (!staged) {
      await this.openOfferSurface(page);
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

    await this.waitForCheckout(page);
    await this.enterTypedAmount(page, offer);
    return this.readStaged(page, offer);
  }

  /**
   * Typed-amount top-ups (catalogue offers: OpenRouter, OpenAI): put the package amount
   * in the amount field before Gate 1 reads the total. If this misses, the prefilled
   * amount's total exceeds the mandate cap and Gate 1 refuses.
   */
  private async enterTypedAmount(page: PageLike, offer: PurchaseOffer): Promise<void> {
    if (!this.cfg.catalogueOffers || !page.actionableCandidates || !page.fillCandidate) return;
    const field = (await page.actionableCandidates()).find((c) => FILLABLE.has(c.role) && AMOUNT_FIELD_RE.test(`${c.name} ${c.near}`));
    if (!field) return;
    await page.fillCandidate(field, String(offer.price));
    await page.settle?.(1500);
    this.emit("AMOUNT_ENTERED", { field: field.name, amount: offer.price });
  }

  /** A PurchaseFailedError, not a DeterministicStepError: the vision resolver must not take this over. */
  private async assertNoAccountSetup(page: PageLike): Promise<void> {
    if (ACCOUNT_SETUP_TEXT_RE.test(await page.innerText().catch(() => ""))) this.throwAccountSetup();
  }

  private throwAccountSetup(): never {
    this.emit("ACCOUNT_SETUP_REQUIRED", { vendor: this.cfg.provider });
    throw new PurchaseFailedError(
      `${this.cfg.provider} needs account setup before it can take payment (a billing address and a saved payment method). ` +
        `Add them once at ${this.cfg.billingOrigin}, then retry. Nothing was bought.`,
      "ACCOUNT_SETUP_REQUIRED",
    );
  }

  private onPaymentOrigin(url: string): boolean {
    return (this.cfg.paymentOrigins ?? []).some((o) => sameOrigin(url, o));
  }

  /** A processor-hosted checkout loads after a cross-origin redirect; give it time. */
  private async waitForCheckout(page: PageLike): Promise<void> {
    for (let i = 0; i < 10 && !(await this.checkoutReady(page).catch(() => false)); i++) await page.settle?.(1000);
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

  /**
   * Bring the top-up packages into view before staging: open the entry page,
   * clear promo/cookie overlays, and click the reveal control (e.g. the profile
   * avatar) so a menu-hidden "Top-up credits" entry becomes an actionable
   * candidate for the picker/replay. All best-effort — a vendor whose packs are
   * already on the pricing page needs no reveal and this is a no-op nav.
   */
  private async openOfferSurface(page: PageLike): Promise<void> {
    await page.goto(this.url(this.cfg.offerEntryPath ?? this.pricingPath));
    await page.settle?.(1500);
    await page.dismissOverlays?.(this.cfg.dismissSelectors ?? []).catch(() => {});
    const revealSelectors = this.cfg.offerRevealSelectors ?? [];
    for (const [i, selector] of revealSelectors.entries()) {
      // Wait for the control (e.g. the top-right avatar) to actually render, and
      // clear overlays again, BEFORE clicking — a bare fast click on a not-yet-
      // ready or promo-covered avatar silently misses and the menu never opens.
      await page.waitForSelector(selector, 6000).catch(() => {});
      await page.dismissOverlays?.(this.cfg.dismissSelectors ?? []).catch(() => {});
      await page.settle?.(300);
      let clicked = true;
      await page.clickBySelector(selector, 8000).catch(() => {
        clicked = false;
      });
      this.emit("OFFER_REVEAL_STEP", { step: i + 1, clicked });
      await page.settle?.(700);
    }
    // The pack list often sits below the fold and lazy-renders — scroll it in so
    // the picker can actually see (and choose) the target package.
    await page.revealByScrolling?.().catch(() => {});
    if (revealSelectors.length > 0) this.emit("OFFER_SURFACE_REVEALED", { steps: revealSelectors.length });
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
      await this.assertNoAccountSetup(page);

      // Bring below-the-fold packs/controls into the DOM before enumerating.
      await page.revealByScrolling?.().catch(() => {});
      const all = await page.actionableCandidates();
      const candidates: ActionCandidate[] = all
        .filter(
          (c) =>
            !CONFIRM_NAME_RE.test(c.name) &&
            !ACCOUNT_SETUP_CONTROL_RE.test(c.name) &&
            !DISMISS_RE.test(c.name) &&
            !(this.cfg.excludeControlsRegex?.test(c.name) ?? false),
        )
        .map((c, index) => ({ ...c, index }));
      if (candidates.length === 0) {
        // Only setup controls were on offer (e.g. an "add a payment method" dialog): the account isn't ready to pay.
        if (all.some((c) => ACCOUNT_SETUP_CONTROL_RE.test(c.name))) this.throwAccountSetup();
        break;
      }

      const goal =
        `Buy exactly this package: "${offer.label}" (${offer.unitsGranted} units for ${offer.currency} ${offer.price}, one-time). ` +
        `Step ${step + 1}: choose the ONE control that moves toward the checkout for this package. ` +
        `Prefer a "top-up"/"buy credits"/"add credits" path. IGNORE promotional upsells — plan upgrades, discount/"% OFF"/"claim offer" banners, or subscription changes — unless nothing else moves toward buying this credit package. ` +
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
      await this.waitForCheckout(page);
    }
    if (await this.checkoutReady(page)) return recorded;
    throw new DeterministicStepError(
      `Checkout not reached after ${this.maxSteps} resolver steps.`,
      `Open the checkout for '${offer.label}'. Do not pay.`,
    );
  }

  private async checkoutReady(page: PageLike): Promise<boolean> {
    if ((await page.queryAllText("[data-checkout-amount]")).length > 0) return true;
    if (this.onPaymentOrigin(page.currentUrl())) return extractPrice(await page.innerText()) !== undefined;
    const buttons = await page.queryAllText('button, [role="button"], input[type="submit"]');
    if (!buttons.some((b) => CONFIRM_NAME_RE.test(b))) return false;
    return extractPrice(await page.innerText()) !== undefined;
  }

  /** Remove one offer's stale recorded steps so the next run re-resolves it cold (keeps other offers intact). */
  private async invalidateRecording(recorded: RecordedAdapter, key: string): Promise<void> {
    const { [key]: _dropped, ...rest } = recorded.offers;
    await this.cfg.registry.save({
      ...recorded,
      version: recorded.version + 1,
      offers: rest,
      updatedAt: new Date().toISOString(),
    });
  }

  /** The staged checkout total, read the same way as readStaged but without throwing — for the stale-recording sanity check. */
  private async peekCheckoutTotal(page: PageLike): Promise<number | undefined> {
    const rawAmount = await this.first(page, "[data-checkout-amount]");
    if (rawAmount !== undefined) {
      const n = Number(rawAmount.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n)) return n;
    }
    const total = extractCheckoutTotal(await page.innerText()) ?? extractPrice(await page.innerText());
    return total !== undefined && Number.isFinite(total) ? total : undefined;
  }

  private async readStaged(page: PageLike, offer: PurchaseOffer): Promise<StagedPurchase> {
    // Origin lock extends to the checkout: the billing origin or a configured processor, nothing else.
    const here = page.currentUrl();
    if (!this.canHandle(here) && !this.onPaymentOrigin(here)) {
      throw new PurchaseFailedError(
        `The checkout is on ${here}, which is neither the billing origin nor a configured payment origin. Aborting before submit.`,
        "CHECKOUT_ORIGIN_NOT_ALLOWED",
      );
    }
    const text = await page.innerText();
    const rawAmount = await this.first(page, "[data-checkout-amount]");
    const amount = rawAmount !== undefined ? Number(rawAmount.replace(/[^0-9.]/g, "")) : (extractCheckoutTotal(text) ?? extractPrice(text));
    if (amount === undefined || !Number.isFinite(amount)) {
      throw new DeterministicStepError("Checkout total not readable.", "Open the checkout so the order total is visible. Do not pay.");
    }
    // Fail closed on a misread: a real checkout never totals less than the package
    // (e.g. picking up a "$0.00 credit balance" elsewhere on the page). Gate 1 only
    // checks the upper bound, so the lower bound lives here.
    if (amount + 0.005 < offer.price) {
      throw new PurchaseFailedError(
        `Read a checkout total of ${amount}, below the ${offer.price} package price. Refusing to submit on a misread total.`,
        "STAGED_AMOUNT_BELOW_PACKAGE",
      );
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
    if (this.onPaymentOrigin(page.currentUrl())) {
      await page.waitForSelector('button[type="submit"]', 15_000).catch(() => {});
      await this.enterStripeTestCardIfNeeded(page);
      await this.declineStripeLinkSignup(page);
    }

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
    if (!clicked && this.onPaymentOrigin(page.currentUrl()) && page.clickByRole && (await page.clickByRole("button", /^pay(\s|$)/i))) {
      clicked = { role: "button", name: "Pay" };
    }
    if (!clicked) {
      throw new DeterministicStepError("Confirm control not found.", "Confirm control not found. The final submit is never delegated to a model.");
    }
    this.emit("CONFIRM_CLICKED", { role: clicked.role, name: clicked.name, deterministic: true });
    this.awaitingCredit = true;

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
    // A bank challenge is not a failure and not a success: hand it to the human.
    if (await this.challengePresent(page)) {
      this.emit("CHECKOUT_CHALLENGE", { kind: "3DS_OR_OTP" });
      throw new TakeoverRequiredError("3DS_CHALLENGE");
    }
    const tx = await this.first(page, "[data-transaction-id]");
    return tx === undefined ? { confirmed: true } : { confirmed: true, transactionId: tx };
  }

  /**
   * Stripe Link's "Save my information for faster checkout" is the user's choice, never
   * Aisle's. Left ticked it demands a phone number and Pay silently does nothing.
   */
  private async declineStripeLinkSignup(page: PageLike): Promise<void> {
    if (!page.setChecked || !sameOrigin(page.currentUrl(), "https://checkout.stripe.com")) return;
    if (await page.setChecked("#enableStripePass", false).catch(() => false)) {
      this.emit("LINK_SIGNUP_DECLINED", { processor: "stripe" });
    }
  }

  /** Deterministic, test mode only. Skipped when Stripe shows a saved card instead of card fields. */
  private async enterStripeTestCardIfNeeded(page: PageLike): Promise<void> {
    if (!this.cfg.stripeTestCard) return;
    const url = page.currentUrl();
    if (!sameOrigin(url, "https://checkout.stripe.com")) return;
    if (!/\/cs_test_/.test(url)) {
      throw new PurchaseFailedError("Refusing to enter Stripe's test card outside a test-mode Checkout Session.", "TEST_CARD_OUTSIDE_TEST_MODE");
    }
    const visible = (selector: string) => page.waitForSelector(selector, 1500).then(() => true, () => false);
    if (!(await visible("#cardNumber"))) {
      this.emit("SAVED_CARD_USED", { processor: "stripe", testMode: true });
      return;
    }
    await page.fill("#cardNumber", STRIPE_TEST_CARD.number);
    await page.fill("#cardExpiry", STRIPE_TEST_CARD.expiry);
    await page.fill("#cardCvc", STRIPE_TEST_CARD.cvc);
    if (await visible("#billingName")) await page.fill("#billingName", STRIPE_TEST_CARD.name);
    if (await visible("#billingPostalCode")) await page.fill("#billingPostalCode", STRIPE_TEST_CARD.postalCode);
    this.emit("TEST_CARD_ENTERED", { processor: "stripe", last4: "4242", testMode: true });
  }

  async verifyEntitlement(page: PageLike, requirement: Requirement): Promise<PurchaseVerification> {
    if (this.cfg.balanceReader) {
      // Read balance, not receipt: the vendor's API. After a submit the vendor credits
      // asynchronously (payment → webhook/redirect), so wait for the balance to move.
      const baseline = this.awaitingCredit ? this.lastApiBalance : undefined;
      const deadline = Date.now() + (this.cfg.balanceSettleMs ?? 45_000);
      let balance = await this.cfg.balanceReader();
      while (baseline !== undefined && (balance === undefined || balance <= baseline) && Date.now() < deadline) {
        await sleep(2000);
        balance = await this.cfg.balanceReader();
      }
      this.awaitingCredit = false;
      if (balance !== undefined) this.lastApiBalance = balance;
      this.emit("BALANCE_READ", { source: "vendor_api", balance });
      const viaApi: PurchaseVerification = { confirmed: balance !== undefined && balance >= requirement.amount, resource: requirement.resource };
      if (balance !== undefined) viaApi.balanceAfter = balance;
      return viaApi;
    }
    for (const path of this.accountPaths) {
      await page.goto(this.url(path));
      await page.settle?.(2000);
      // The reveal (avatar dropdown) is intermittent — the click can miss, a promo
      // can re-cover it, or the menu closes before the read. Retry the whole
      // dismiss → reveal → read on this page a few times before moving on.
      for (let attempt = 0; attempt < BALANCE_READ_ATTEMPTS; attempt++) {
        // Clear promo/cookie overlays first — otherwise they intercept the reveal
        // click and the avatar wait hangs on the 90s action default ("cursor stuck").
        if (this.cfg.balanceRevealSelector || this.cfg.dismissSelectors) {
          await page.dismissOverlays?.(this.cfg.dismissSelectors ?? []).catch(() => {});
          await page.settle?.(400);
        }
        // Reveal a menu-hidden balance (e.g. an avatar dropdown) WITHOUT reloading.
        // Bounded so a still-obscured avatar fails fast instead of stalling the read.
        if (this.cfg.balanceRevealSelector) {
          await page.clickBySelector(this.cfg.balanceRevealSelector, 8000).catch(() => {});
          await page.settle?.(900);
        }
        const balance = await this.readBalanceFromDom(page);
        if (balance !== undefined) {
          this.emit("BALANCE_READ", { source: "page", balance, path, attempt: attempt + 1 });
          const out: PurchaseVerification = { confirmed: balance >= requirement.amount, resource: requirement.resource, balanceAfter: balance };
          const tx = await this.first(page, "[data-last-transaction-id]");
          if (tx) out.transactionId = tx;
          return out;
        }
        await page.settle?.(700);
      }
      this.emit("BALANCE_READ_MISS", { path });
    }
    return { confirmed: false, reason: "Could not read an authoritative balance from the account pages." };
  }

  /** Parse the balance from the current DOM: known selectors first, then a whole-page text scan. */
  private async readBalanceFromDom(page: PageLike): Promise<number | undefined> {
    for (const selector of this.balanceSelectors) {
      const raw = await this.first(page, selector);
      if (raw === undefined) continue;
      const fromLabel = extractBalance(raw) ?? (() => {
        const labelled = /\bcredits?\b\s*[:=-]?\s*(-?[\d,]+(?:\.\d+)?)/i.exec(raw) ?? /(-?[\d,]+(?:\.\d+)?)\s*\bcredits?\b/i.exec(raw);
        return labelled?.[1] === undefined ? undefined : Number(labelled[1].replace(/,/g, ""));
      })();
      const fromNumber = Number(raw.replace(/[^0-9.-]/g, ""));
      const parsed = fromLabel ?? (Number.isFinite(fromNumber) ? fromNumber : undefined);
      if (parsed !== undefined && Number.isFinite(parsed)) return parsed;
    }
    const fromText = extractBalance(await page.innerText());
    return fromText !== undefined && Number.isFinite(fromText) ? fromText : undefined;
  }
}
