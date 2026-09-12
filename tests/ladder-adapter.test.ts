import { describe, it, expect } from "vitest";
import type { ActionCandidate, PageLike } from "../src/slow-lane/browser.js";
import { CONFIRM_NAME_RE, LadderVendorAdapter, offersFromJsonLd } from "../src/slow-lane/adapters/ladder-adapter.js";
import { InMemoryAdapterRegistry } from "../src/slow-lane/adapters/recorded-adapter.js";
import type { CandidatePicker, PickRequest } from "../src/slow-lane/resolver/picker.js";
import { DeterministicStepError } from "../src/slow-lane/vendor-adapter.js";
import type { PurchaseOffer } from "../src/types.js";

const ORIGIN = "https://shop.test";

interface ShopOffer {
  sku: string;
  label: string;
  units: number;
  price: number;
}

/** A tiny model of the mock vendor website behind the PageLike port. */
class FakeShop implements PageLike {
  path = "/";
  balance = 0;
  staged: ShopOffer | undefined;
  confirms = 0;
  loggedIn = true;
  readonly offers: ShopOffer[] = [
    { sku: "c1000", label: "1,000 credits", units: 1000, price: 5 },
    { sku: "c5000", label: "5,000 credits", units: 5000, price: 20 },
  ];

  constructor(private readonly opts: { buyPrefix?: string; extraPricingButton?: string } = {}) {}

  private buyName(o: ShopOffer): string {
    return `${this.opts.buyPrefix ?? "Buy"} ${o.label}`;
  }

  currentUrl(): string {
    return ORIGIN + this.path;
  }
  async goto(url: string): Promise<void> {
    const p = new URL(url).pathname;
    this.path = p === "/account" && !this.loggedIn ? "/login" : p;
  }
  async actionableCandidates(): Promise<ActionCandidate[]> {
    const list: Array<{ role: string; name: string }> =
      this.path === "/pricing"
        ? [
            { role: "link", name: "Account" },
            ...this.offers.map((o) => ({ role: "button", name: this.buyName(o) })),
            ...(this.opts.extraPricingButton ? [{ role: "button", name: this.opts.extraPricingButton }] : []),
          ]
        : this.path === "/checkout"
          ? [
              { role: "link", name: "Back to pricing" },
              { role: "button", name: "Complete purchase" },
            ]
          : [];
    return list.map((c, index) => ({ index, near: "", ...c }));
  }
  async clickCandidate(c: ActionCandidate): Promise<void> {
    this.act(c.name);
  }
  async clickByRole(role: string, name: string | RegExp): Promise<boolean> {
    const hit = (await this.actionableCandidates()).find((c) => c.role === role && (typeof name === "string" ? c.name === name : name.test(c.name)));
    if (!hit) return false;
    this.act(hit.name);
    return true;
  }
  private act(name: string): void {
    const offer = this.offers.find((o) => this.buyName(o) === name);
    if (this.path === "/pricing" && offer) {
      this.staged = offer;
      this.path = "/checkout";
    } else if (this.path === "/checkout" && name === "Complete purchase" && this.staged) {
      this.confirms += 1;
      this.balance += this.staged.units;
      this.path = "/confirm";
    }
  }
  async jsonLd(): Promise<unknown[]> {
    return this.path === "/pricing"
      ? [this.offers.map((o) => ({ "@type": "Offer", sku: o.sku, name: o.label, price: o.price, priceCurrency: "USD", eligibleQuantity: { value: o.units } }))]
      : [];
  }
  async queryAllText(selector: string): Promise<string[]> {
    if (this.path === "/checkout" && this.staged) {
      const fields: Record<string, string> = {
        "[data-checkout-amount]": this.staged.price.toFixed(2),
        "[data-checkout-line]": this.staged.label,
        "[data-checkout-currency]": "USD",
        "[data-checkout-period]": "one_time",
        "[data-checkout-autorenew]": "false",
      };
      if (fields[selector] !== undefined) return [fields[selector]!];
      if (selector.startsWith("button")) return ["Complete purchase"];
    }
    if (this.path === "/confirm" && selector === "[data-transaction-id]") return [`txn_${this.confirms}`];
    if (this.path === "/account") {
      if (selector === "[data-balance]") return [String(this.balance)];
      if (selector === "[data-account-email]") return ["demo@aisle.dev"];
    }
    return [];
  }
  async innerText(): Promise<string> {
    return this.path === "/checkout" && this.staged ? `Item ${this.staged.label} Total $${this.staged.price}` : "";
  }
  async clickByText(): Promise<void> {}
  async clickBySelector(): Promise<void> {}
  async fill(): Promise<void> {}
  async textContent(): Promise<string | null> {
    return null;
  }
  async waitForSelector(): Promise<void> {}
  async tryClickByText(): Promise<boolean> {
    return false;
  }
}

/** Picks the candidate whose name matches, and records what it was shown. */
function namePicker(target: RegExp) {
  const seen: PickRequest[] = [];
  const picker: CandidatePicker = {
    async pick(req) {
      seen.push(req);
      const hit = req.candidates.find((c) => target.test(c.name));
      if (!hit) throw new Error("target not offered");
      return { index: hit.index, why: "matches package", modelUsed: "fake/model", replayed: false };
    },
  };
  return { picker, seen };
}

const offer5000: PurchaseOffer = { productId: "c5000", label: "5,000 credits", unitsGranted: 5000, price: 20, currency: "USD", billing: "one_time", autoRenew: false };
const req = { resource: "image_credits", amount: 1067 };

describe("tier 1: JSON-LD offers", () => {
  it("parses Offer blocks with eligibleQuantity, including @graph and Product.offers", () => {
    const offers = offersFromJsonLd([
      { "@graph": [{ "@type": "Offer", sku: "a", name: "1,000 credits", price: "5", priceCurrency: "USD", eligibleQuantity: { value: 1000 } }] },
      { "@type": "Product", name: "Pro 5,000 credits", sku: "b", offers: { "@type": "Offer", price: 20, priceCurrency: "USD" } },
      { "@type": "Offer", name: "Monthly 20,000 credits", price: 30, priceCurrency: "USD" },
    ]);
    expect(offers.map((o) => [o.productId, o.unitsGranted, o.price, o.billing])).toEqual([
      ["a", 1000, 5, "one_time"],
      ["b", 5000, 20, "one_time"],
      ["ld_20000_30", 20000, 30, "subscription"],
    ]);
  });
});

describe("ladder adapter", () => {
  it("cold run: tier-3 picker stages the package, promotes it, and submit stays deterministic", async () => {
    const page = new FakeShop();
    const registry = new InMemoryAdapterRegistry();
    const { picker, seen } = namePicker(/^Buy 5,000 credits$/);
    const events: string[] = [];
    const adapter = new LadderVendorAdapter({ provider: "mock", billingOrigin: ORIGIN, registry, picker, loggedInSelector: "[data-account-email]", onEvent: (t) => events.push(t) });

    expect(await adapter.ensureLoggedIn(page)).toBe(true);
    const offers = await adapter.discoverOffers(page, req);
    expect(events).toContain("OFFERS_FROM_JSON_LD");
    expect(offers.map((o) => o.productId)).toEqual(["c1000", "c5000"]);

    const staged = await adapter.stagePurchase(page, offer5000);
    expect(staged).toMatchObject({ amount: 20, currency: "USD", billingPeriod: "one_time", autoRenew: false, lineItem: "5,000 credits" });
    expect(seen).toHaveLength(1);
    expect(events).toContain("ADAPTER_RECORDED");
    expect((await registry.load(ORIGIN))?.offers["units:5000"]).toEqual([{ action: "click", role: "button", name: "Buy 5,000 credits" }]);

    const confirmation = await adapter.confirmPurchase(page, staged);
    expect(confirmation).toEqual({ confirmed: true, transactionId: "txn_1" });
    expect((await registry.load(ORIGIN))?.confirm).toEqual({ role: "button", name: "Complete purchase" });
    expect((await adapter.verifyEntitlement(page, req)).balanceAfter).toBe(5000);
  });

  it("warm run: tier-2 replay stages without calling the model", async () => {
    const registry = new InMemoryAdapterRegistry();
    await new LadderVendorAdapter({ provider: "mock", billingOrigin: ORIGIN, registry, picker: namePicker(/^Buy 5,000 credits$/).picker }).stagePurchase(
      Object.assign(new FakeShop(), { path: "/pricing" }),
      offer5000,
    );

    const noModel: CandidatePicker = { pick: async () => { throw new Error("model must not be called on a warm run"); } };
    const events: string[] = [];
    const page = Object.assign(new FakeShop(), { path: "/pricing" });
    const staged = await new LadderVendorAdapter({ provider: "mock", billingOrigin: ORIGIN, registry, picker: noModel, onEvent: (t) => events.push(t) }).stagePurchase(page, offer5000);
    expect(staged.amount).toBe(20);
    expect(events).toEqual(["ADAPTER_REPLAY"]);
  });

  it("a replay miss falls back to tier 3 and re-records with a new version", async () => {
    const registry = new InMemoryAdapterRegistry();
    await new LadderVendorAdapter({ provider: "mock", billingOrigin: ORIGIN, registry, picker: namePicker(/^Buy 5,000 credits$/).picker }).stagePurchase(
      Object.assign(new FakeShop(), { path: "/pricing" }),
      offer5000,
    );
    const redesigned = Object.assign(new FakeShop({ buyPrefix: "Get" }), { path: "/pricing" });
    const events: string[] = [];
    await new LadderVendorAdapter({ provider: "mock", billingOrigin: ORIGIN, registry, picker: namePicker(/^Get 5,000 credits$/).picker, onEvent: (t) => events.push(t) }).stagePurchase(redesigned, offer5000);
    expect(events).toEqual(["ADAPTER_REPLAY", "ADAPTER_MISS", "RESOLVER_CALLED", "ADAPTER_RECORDED"]);
    const adapter = await registry.load(ORIGIN);
    expect(adapter?.version).toBe(2);
    expect(adapter?.offers["units:5000"]?.[0]?.name).toBe("Get 5,000 credits");
  });

  it("never offers a paying control to the model", async () => {
    const page = Object.assign(new FakeShop({ extraPricingButton: "Pay now" }), { path: "/pricing" });
    const { picker, seen } = namePicker(/^Buy 5,000 credits$/);
    await new LadderVendorAdapter({ provider: "mock", billingOrigin: ORIGIN, registry: new InMemoryAdapterRegistry(), picker }).stagePurchase(page, offer5000);
    const names = seen.flatMap((s) => s.candidates.map((c) => c.name));
    expect(names).not.toContain("Pay now");
    expect(names.every((n) => !CONFIRM_NAME_RE.test(n))).toBe(true);
    expect(seen[0]?.candidates.map((c) => c.index)).toEqual(seen[0]?.candidates.map((_c, i) => i));
  });

  it("with no recording and no resolver it raises a DeterministicStepError", async () => {
    const page = Object.assign(new FakeShop(), { path: "/pricing" });
    await expect(
      new LadderVendorAdapter({ provider: "mock", billingOrigin: ORIGIN, registry: new InMemoryAdapterRegistry() }).stagePurchase(page, offer5000),
    ).rejects.toBeInstanceOf(DeterministicStepError);
  });

  it("detects a login wall", async () => {
    const page = new FakeShop();
    page.loggedIn = false;
    expect(await new LadderVendorAdapter({ provider: "mock", billingOrigin: ORIGIN, registry: new InMemoryAdapterRegistry() }).ensureLoggedIn(page)).toBe(false);
  });
});
