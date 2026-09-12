/**
 * In-memory mock of a vendor website with a pricing → checkout → account flow,
 * plus the matching adapter, browser provider and control surface. Lets the slow
 * lane run end-to-end with no real browser and no money — the analogue of the
 * fast lane's MockWebMcpVendor.
 *
 * Set `failDiscoverUntilAssisted: true` to make the deterministic "find pricing"
 * step fail until the computer-use agent "clicks" something, exercising the
 * fallback path.
 */

import type {
  BrowserProfile,
  BrowserProvider,
  BrowserSession,
  ControlSurface,
  CreateSessionOptions,
  PageLike,
} from "../browser.js";
import {
  DeterministicStepError,
  type VendorPurchaseAdapter,
} from "../vendor-adapter.js";
import { TakeoverRequiredError } from "../../errors.js";
import type {
  PurchaseOffer,
  PurchaseVerification,
  Requirement,
  StagedPurchase,
} from "../../types.js";

export interface MockVendorConfig {
  provider?: string;
  origin?: string;
  startingBalance?: number;
  accountId?: string;
  offers?: PurchaseOffer[];
  failDiscoverUntilAssisted?: boolean;
  /** Simulate the vendor redirecting navigation to a different origin. */
  redirectOrigin?: string;
  /** Confirm "succeeds" but credits never post (verification must fail). */
  dropCredits?: boolean;
  /** Confirm raises a 3-DS-style TakeoverRequiredError until takeover clears it. */
  require3dsOnceOnConfirm?: boolean;
}

const DEFAULT_OFFERS: PurchaseOffer[] = [
  { productId: "credits_1000", label: "1,000 credits", units: 1000, price: 5, currency: "USD", billing: "one_time" },
  { productId: "credits_5000", label: "5,000 credits", units: 5000, price: 20, currency: "USD", billing: "one_time" },
  { productId: "credits_20000", label: "20,000 credits", units: 20000, price: 70, currency: "USD", billing: "one_time" },
];

/** The authoritative in-memory state of the fake vendor. */
export class MockVendorSite {
  readonly provider: string;
  readonly origin: string;
  readonly accountId: string;
  readonly offers: PurchaseOffer[];
  balance: number;
  path = "/";
  url: string;
  stagedProductId?: string;
  lastTxn?: string;
  discoverUnlocked: boolean;
  purchaseClicks = 0;
  readonly redirectOrigin?: string;
  readonly dropCredits: boolean;
  readonly require3ds: boolean;
  takeoverCleared = false;

  constructor(cfg: MockVendorConfig = {}) {
    this.provider = cfg.provider ?? "mock-slow-vendor";
    this.origin = cfg.origin ?? "https://shop.mock-slow-vendor.test";
    this.accountId = cfg.accountId ?? "acct_slow_001";
    this.offers = cfg.offers ?? DEFAULT_OFFERS;
    this.balance = cfg.startingBalance ?? 0;
    this.url = this.origin + "/";
    this.discoverUnlocked = !cfg.failDiscoverUntilAssisted;
    this.redirectOrigin = cfg.redirectOrigin;
    this.dropCredits = cfg.dropCredits ?? false;
    this.require3ds = cfg.require3dsOnceOnConfirm ?? false;
  }
}

/** PageLike backed by the site model. Encodes offers as parseable strings. */
class MockPage implements PageLike {
  constructor(private readonly site: MockVendorSite) {}

  currentUrl(): string {
    return this.site.url;
  }
  async goto(url: string): Promise<void> {
    // A malicious vendor can redirect the navigation to another origin.
    const effective = this.site.redirectOrigin ? this.site.redirectOrigin + "/" : url;
    const u = new URL(effective);
    this.site.url = effective;
    this.site.path = u.pathname === "" ? "/" : u.pathname;
  }
  async clickByText(text: string): Promise<void> {
    if (this.site.path === "/pricing") {
      const offer = this.site.offers.find((o) => text.includes(o.label));
      if (offer) {
        this.site.stagedProductId = offer.productId;
        this.site.path = "/checkout";
        this.site.url = this.site.origin + "/checkout";
      }
      return;
    }
    if (this.site.path === "/checkout" && /confirm|pay/i.test(text)) {
      this.site.purchaseClicks += 1;
      const offer = this.site.offers.find((o) => o.productId === this.site.stagedProductId);
      if (offer && !this.site.dropCredits) {
        this.site.balance += offer.units;
      }
      this.site.lastTxn = `txn_mock_${this.site.purchaseClicks}`;
    }
  }
  async innerText(): Promise<string> {
    if (this.site.path === "/pricing" && this.site.discoverUnlocked) {
      return this.site.offers
        .map((o) => `${o.label} — $${o.price} for ${o.units} credits`)
        .join("\n");
    }
    if (this.site.path === "/checkout") {
      const offer = this.site.offers.find((o) => o.productId === this.site.stagedProductId);
      return offer ? `Order total: $${offer.price}` : "";
    }
    if (this.site.path === "/account") {
      return `Credit balance: ${this.site.balance} credits`;
    }
    return "";
  }
  async tryClickByText(text: string): Promise<boolean> {
    const before = this.site.path;
    await this.clickByText(text);
    return this.site.path !== before || this.site.purchaseClicks > 0;
  }
  async clickBySelector(): Promise<void> {
    /* not used by the mock adapter */
  }
  async fill(): Promise<void> {
    /* no forms in the mock */
  }
  async textContent(selector: string): Promise<string | null> {
    if (selector === ".total" && this.site.path === "/checkout") {
      const offer = this.site.offers.find((o) => o.productId === this.site.stagedProductId);
      return offer ? `$${offer.price}` : null;
    }
    if (selector === ".balance" && this.site.path === "/account") {
      return String(this.site.balance);
    }
    return null;
  }
  async queryAllText(selector: string): Promise<string[]> {
    if (selector === ".offer" && this.site.path === "/pricing" && this.site.discoverUnlocked) {
      // productId::label::units::price::currency
      return this.site.offers.map(
        (o) => `${o.productId}::${o.label}::${o.units}::${o.price}::${o.currency}`,
      );
    }
    return [];
  }
  async waitForSelector(): Promise<void> {
    /* instantaneous in the mock */
  }
}

/** ControlSurface that "unlocks" discovery on any click — stands in for the agent completing a sub-goal. */
class MockControl implements ControlSurface {
  constructor(private readonly site: MockVendorSite) {}
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes, enough for a stub
  }
  viewport(): { width: number; height: number } {
    return { width: 1280, height: 800 };
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
    const session = new MockBrowserSession(
      `sess_mock_${Math.random().toString(36).slice(2, 8)}`,
      opts.provider,
      this.site,
    );
    this.lastSession = session;
    return session;
  }
}

/** Deterministic adapter for the mock vendor site. */
export class MockVendorAdapter implements VendorPurchaseAdapter {
  constructor(private readonly site: MockVendorSite) {}

  get provider(): string {
    return this.site.provider;
  }

  canHandle(url: string): boolean {
    return url.startsWith(this.site.origin);
  }

  async discoverOffers(page: PageLike, _requirement: Requirement): Promise<PurchaseOffer[]> {
    await page.goto(this.site.origin + "/pricing");
    const rows = await page.queryAllText(".offer");
    if (rows.length === 0) {
      throw new DeterministicStepError(
        "Pricing packages not found on the page.",
        "Open the Pricing page and make the credit packages visible.",
      );
    }
    return rows.map((row) => {
      const [productId, label, units, price, currency] = row.split("::");
      return {
        productId: productId ?? "",
        label: label ?? "",
        units: Number(units ?? 0),
        price: Number(price ?? 0),
        currency: currency ?? "USD",
        billing: "one_time" as const,
      };
    });
  }

  async stagePurchase(page: PageLike, offer: PurchaseOffer): Promise<StagedPurchase> {
    await page.clickByText(offer.label);
    const totalText = await page.textContent(".total");
    if (totalText === null) {
      throw new DeterministicStepError(
        "Checkout total not visible.",
        `Select the '${offer.label}' package and open the checkout page.`,
      );
    }
    return {
      offer,
      checkoutRef: "/checkout",
      observedTotal: Number(totalText.replace(/[^0-9.]/g, "")),
      observedCurrency: offer.currency,
    };
  }

  async confirmPurchase(page: PageLike, _staged: StagedPurchase): Promise<PurchaseVerification> {
    if (this.site.require3ds && !this.site.takeoverCleared) {
      throw new TakeoverRequiredError("3-DS challenge presented at checkout.");
    }
    await page.clickByText("Confirm");
    return { confirmed: true, transactionId: this.site.lastTxn };
  }

  async verifyEntitlement(page: PageLike, requirement: Requirement): Promise<PurchaseVerification> {
    await page.goto(this.site.origin + "/account");
    const balanceText = await page.textContent(".balance");
    const balance = balanceText === null ? 0 : Number(balanceText);
    return {
      confirmed: balance >= requirement.amount,
      transactionId: this.site.lastTxn,
      balanceAfter: balance,
      accountId: this.site.accountId,
      resource: "credits",
    };
  }
}
