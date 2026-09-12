/**
 * In-memory mock of a vendor website with a pricing → checkout → account flow,
 * plus the matching adapter, browser provider and control surface. Lets the slow
 * lane run end-to-end with no real browser and no money — the analogue of the
 * scaffold's `mock-vendor` site (build-checklist Phase 4).
 */

import type {
  BrowserProfile,
  BrowserProvider,
  BrowserSession,
  ControlSurface,
  CreateSessionOptions,
  PageLike,
} from "../browser.js";
import { DeterministicStepError, type VendorPurchaseAdapter } from "../vendor-adapter.js";
import { TakeoverRequiredError } from "../../errors.js";
import type { PurchaseOffer, PurchaseVerification, Requirement, StagedPurchase } from "../../types.js";

export interface MockVendorConfig {
  provider?: string;
  origin?: string;
  startingBalance?: number;
  accountId?: string;
  offers?: PurchaseOffer[];
  /** Pricing stays hidden until the resolver "clicks" something. */
  failDiscoverUntilAssisted?: boolean;
  /** Simulate the vendor redirecting navigation to a different origin. */
  redirectOrigin?: string;
  /** Confirm "succeeds" but credits never post (verification must fail). */
  dropCredits?: boolean;
  /** Confirm raises a 3-DS-style TakeoverRequiredError until takeover clears it. */
  require3dsOnceOnConfirm?: boolean;
  /** Stored cookies have expired; the liveness probe must re-authenticate. */
  sessionExpired?: boolean;
  /** Re-authentication fails (e.g. SSO the Credentials vault can't drive). */
  reauthFails?: boolean;
  /** What the checkout page shows — lets tests hit each Gate 1 mismatch. */
  checkoutCurrency?: string;
  checkoutBillingPeriod?: "one_time" | "subscription";
  checkoutAutoRenew?: boolean;
  /** Added to the displayed checkout total (e.g. tax, or a hostile price hike). */
  checkoutSurcharge?: number;
  /** Hide the confirm button (nothing can be submitted). */
  hideConfirm?: boolean;
  /** Charge, then throw as if the confirmation response was lost. */
  loseResponseAfterConfirm?: boolean;
}

const DEFAULT_OFFERS: PurchaseOffer[] = [
  { productId: "credits_1000", label: "1,000 credits", unitsGranted: 1000, price: 5, currency: "USD", billing: "one_time", autoRenew: false },
  { productId: "credits_5000", label: "5,000 credits", unitsGranted: 5000, price: 20, currency: "USD", billing: "one_time", autoRenew: false },
  { productId: "credits_20000", label: "20,000 credits", unitsGranted: 20000, price: 70, currency: "USD", billing: "one_time", autoRenew: false },
];

/** The authoritative in-memory state of the fake vendor. */
export class MockVendorSite {
  readonly provider: string;
  readonly origin: string;
  readonly accountId: string;
  readonly offers: PurchaseOffer[];
  readonly cfg: MockVendorConfig;
  balance: number;
  path = "/";
  url: string;
  stagedProductId?: string;
  lastTxn?: string;
  discoverUnlocked: boolean;
  loggedIn: boolean;
  reauthCount = 0;
  purchaseClicks = 0;
  takeoverCleared = false;

  constructor(cfg: MockVendorConfig = {}) {
    this.cfg = cfg;
    this.provider = cfg.provider ?? "mock-slow-vendor";
    this.origin = cfg.origin ?? "https://shop.mock-slow-vendor.test";
    this.accountId = cfg.accountId ?? "acct_slow_001";
    this.offers = cfg.offers ?? DEFAULT_OFFERS;
    this.balance = cfg.startingBalance ?? 0;
    this.url = this.origin + "/";
    this.discoverUnlocked = !cfg.failDiscoverUntilAssisted;
    this.loggedIn = !cfg.sessionExpired;
  }

  stagedOffer(): PurchaseOffer | undefined {
    return this.offers.find((o) => o.productId === this.stagedProductId);
  }

  checkoutTotal(): number | undefined {
    const offer = this.stagedOffer();
    return offer ? offer.price + (this.cfg.checkoutSurcharge ?? 0) : undefined;
  }

  checkoutPeriod(): "one_time" | "subscription" {
    return this.cfg.checkoutBillingPeriod ?? "one_time";
  }
}

class MockPage implements PageLike {
  constructor(private readonly site: MockVendorSite) {}

  currentUrl(): string {
    return this.site.url;
  }
  async goto(url: string): Promise<void> {
    const effective = this.site.cfg.redirectOrigin ? this.site.cfg.redirectOrigin + "/" : url;
    const u = new URL(effective);
    this.site.url = effective;
    this.site.path = u.pathname === "" ? "/" : u.pathname;
  }
  /** Returns whether a control matched. */
  private click(text: string): boolean {
    const site = this.site;
    if (site.path === "/pricing" && site.discoverUnlocked) {
      const offer = site.offers.find((o) => text.includes(o.label) || o.label.includes(text));
      if (!offer) return false;
      site.stagedProductId = offer.productId;
      site.path = "/checkout";
      site.url = site.origin + "/checkout";
      return true;
    }
    if (site.path === "/checkout" && !site.cfg.hideConfirm && /confirm|pay|complete purchase/i.test(text)) {
      site.purchaseClicks += 1;
      const offer = site.stagedOffer();
      if (offer && !site.cfg.dropCredits) site.balance += offer.unitsGranted;
      site.lastTxn = `txn_mock_${site.purchaseClicks}`;
      if (site.cfg.loseResponseAfterConfirm) throw new Error("net::ERR_CONNECTION_RESET");
      return true;
    }
    return false;
  }
  async clickByText(text: string): Promise<void> {
    if (!this.click(text)) throw new Error(`No element with text '${text}'`);
  }
  async tryClickByText(text: string): Promise<boolean> {
    return this.click(text);
  }
  async innerText(): Promise<string> {
    const site = this.site;
    if (site.path === "/pricing" && site.discoverUnlocked) {
      return site.offers.map((o) => `${o.label} — $${o.price} for ${o.unitsGranted} credits`).join("\n");
    }
    if (site.path === "/checkout") {
      const offer = site.stagedOffer();
      if (!offer) return "";
      return [
        `Order: ${offer.label}`,
        `Order total: $${site.checkoutTotal()}`,
        site.checkoutPeriod() === "subscription" ? "Billed monthly" : "One-time purchase",
        site.cfg.checkoutAutoRenew ? "Auto-renew: on" : "No auto-renew",
      ].join("\n");
    }
    if (site.path === "/account") {
      return [`Plan: Pro — includes 5,000 credits/month`, `Credit balance: ${site.balance} credits`].join("\n");
    }
    return "";
  }
  async clickBySelector(): Promise<void> {}
  async fill(): Promise<void> {}
  async textContent(selector: string): Promise<string | null> {
    const site = this.site;
    if (site.path === "/checkout" && site.stagedOffer()) {
      if (selector === ".total") return `$${site.checkoutTotal()}`;
      if (selector === ".line") return site.stagedOffer()?.label ?? null;
      if (selector === ".currency") return site.cfg.checkoutCurrency ?? "USD";
      if (selector === ".period") return site.checkoutPeriod();
      if (selector === ".autorenew") return String(site.cfg.checkoutAutoRenew ?? false);
    }
    if (selector === ".balance" && site.path === "/account") return String(site.balance);
    if (selector === ".account-email" && site.path === "/account") return site.loggedIn ? "demo@aisle.dev" : null;
    return null;
  }
  async queryAllText(selector: string): Promise<string[]> {
    if (selector === ".offer" && this.site.path === "/pricing" && this.site.discoverUnlocked) {
      return this.site.offers.map(
        (o) => `${o.productId}::${o.label}::${o.unitsGranted}::${o.price}::${o.currency}::${o.billing}::${o.autoRenew}`,
      );
    }
    return [];
  }
  async waitForSelector(): Promise<void> {}
}

/** Any click "reveals" pricing — stands in for the resolver completing a sub-goal. */
class MockControl implements ControlSurface {
  constructor(private readonly site: MockVendorSite) {}
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  }
  viewport(): { width: number; height: number } {
    return { width: 1280, height: 720 };
  }
  async mouseClick(): Promise<void> {
    this.site.discoverUnlocked = true;
    if (this.site.path !== "/pricing") {
      this.site.path = "/pricing";
      this.site.url = this.site.origin + "/pricing";
    }
  }
  async type(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scroll(): Promise<void> {}
  currentUrl(): string {
    return this.site.url;
  }
}

class MockBrowserSession implements BrowserSession {
  readonly page: PageLike;
  readonly control: ControlSurface;
  readonly sessionViewerUrl: string;
  closed = false;

  constructor(
    readonly sessionId: string,
    readonly provider: string,
    private readonly site: MockVendorSite,
  ) {
    this.page = new MockPage(site);
    this.control = new MockControl(site);
    this.sessionViewerUrl = `https://app.steel.dev/sessions/${sessionId}`;
  }

  async saveProfile(): Promise<BrowserProfile> {
    return {
      provider: this.provider,
      context: { cookies: [{ name: "session", value: "mock" }], account: this.site.accountId },
      savedAt: new Date().toISOString(),
    };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

export class MockBrowserProvider implements BrowserProvider {
  lastSession?: MockBrowserSession;
  constructor(private readonly site: MockVendorSite) {}

  async createSession(opts: CreateSessionOptions): Promise<BrowserSession> {
    const session = new MockBrowserSession(`sess_mock_${Math.random().toString(36).slice(2, 8)}`, opts.provider, this.site);
    this.lastSession = session;
    return session;
  }
}

/** Deterministic, recorded-style adapter for the mock vendor site (tier 2). */
export class MockVendorAdapter implements VendorPurchaseAdapter {
  constructor(private readonly site: MockVendorSite) {}

  get provider(): string {
    return this.site.provider;
  }

  canHandle(url: string): boolean {
    return url.startsWith(this.site.origin);
  }

  async ensureLoggedIn(page: PageLike): Promise<boolean> {
    await page.goto(this.site.origin + "/account");
    if (await page.textContent(".account-email")) return true;
    // Re-authenticate via the Steel Credentials API path.
    this.site.reauthCount += 1;
    if (!this.site.cfg.reauthFails) this.site.loggedIn = true;
    return (await page.textContent(".account-email")) !== null;
  }

  async discoverOffers(page: PageLike, _requirement: Requirement): Promise<PurchaseOffer[]> {
    await page.goto(this.site.origin + "/pricing");
    const rows = await page.queryAllText(".offer");
    if (rows.length === 0) {
      throw new DeterministicStepError("Pricing packages not found on the page.", "Open the Pricing page and make the credit packages visible.");
    }
    return rows.map((row) => {
      const [productId, label, units, price, currency, billing, autoRenew] = row.split("::");
      return {
        productId: productId ?? "",
        label: label ?? "",
        unitsGranted: Number(units ?? 0),
        price: Number(price ?? 0),
        currency: currency ?? "USD",
        billing: billing === "subscription" ? "subscription" : "one_time",
        autoRenew: autoRenew === "true",
      };
    });
  }

  async stagePurchase(page: PageLike, offer: PurchaseOffer): Promise<StagedPurchase> {
    await page.clickByText(offer.label);
    const total = await page.textContent(".total");
    if (total === null) {
      throw new DeterministicStepError("Checkout total not visible.", `Select the '${offer.label}' package and open the checkout page.`);
    }
    return {
      offer,
      checkoutRef: "/checkout",
      lineItem: (await page.textContent(".line")) ?? "",
      amount: Number(total.replace(/[^0-9.]/g, "")),
      currency: (await page.textContent(".currency")) ?? "",
      billingPeriod: (await page.textContent(".period")) === "subscription" ? "subscription" : "one_time",
      autoRenew: (await page.textContent(".autorenew")) === "true",
    };
  }

  async confirmPurchase(page: PageLike, _staged: StagedPurchase): Promise<PurchaseVerification> {
    if (this.site.cfg.require3dsOnceOnConfirm && !this.site.takeoverCleared) {
      throw new TakeoverRequiredError("3-DS challenge presented at checkout.");
    }
    if (!(await page.tryClickByText("Complete purchase"))) {
      throw new DeterministicStepError("Confirm button not found.", "Confirm control not found.");
    }
    return this.site.lastTxn === undefined ? { confirmed: true } : { confirmed: true, transactionId: this.site.lastTxn };
  }

  async verifyEntitlement(page: PageLike, requirement: Requirement): Promise<PurchaseVerification> {
    await page.goto(this.site.origin + "/account");
    const text = await page.textContent(".balance");
    const balance = text === null ? undefined : Number(text);
    const out: PurchaseVerification = {
      confirmed: balance !== undefined && balance >= requirement.amount,
      accountId: this.site.accountId,
      resource: "credits",
    };
    if (balance !== undefined) out.balanceAfter = balance;
    if (this.site.lastTxn !== undefined) out.transactionId = this.site.lastTxn;
    return out;
  }
}
