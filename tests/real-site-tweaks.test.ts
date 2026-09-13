import { describe, it, expect } from "vitest";
import type { PageLike } from "../src/slow-lane/browser.js";
import { LadderVendorAdapter } from "../src/slow-lane/adapters/ladder-adapter.js";
import { InMemoryAdapterRegistry } from "../src/slow-lane/adapters/recorded-adapter.js";
import { loadUpstreams } from "../src/gateway/upstreams.js";
import { classifyFailure } from "../src/classifier.js";
import "../src/gateway/gateway.js"; // registers the openai + higgsfield vendor rules
import type { PurchaseOffer } from "../src/types.js";

const ORIGIN = "https://platform.vendor.test";
const offer5: PurchaseOffer = { productId: "credits_5", label: "$5 API credits", unitsGranted: 5, price: 5, currency: "USD", billing: "one_time", autoRenew: false };

/** A billing page whose only visible price is the current balance, e.g. OpenAI's overview. */
function billingPage(opts: { checkoutText: string; confirmVisible: boolean }): PageLike {
  let path = "/";
  return {
    currentUrl: () => ORIGIN + path,
    goto: async (url) => void (path = new URL(url).pathname),
    innerText: async () => (path === "/checkout" ? opts.checkoutText : "Credit balance $0.00\nAdd to credit balance"),
    queryAllText: async (sel) => (sel.startsWith("button") && opts.confirmVisible && path === "/checkout" ? ["Confirm payment"] : []),
    clickByRole: async (_role, name) => {
      if (name === "Add to credit balance" && path === "/billing") {
        path = "/checkout";
        return true;
      }
      return false;
    },
    clickByText: async () => {},
    clickBySelector: async () => {},
    fill: async () => {},
    textContent: async () => null,
    waitForSelector: async () => {},
    tryClickByText: async () => false,
  };
}

const registryWith = async () => {
  const r = new InMemoryAdapterRegistry();
  await r.save({ billingOrigin: ORIGIN, version: 1, offers: { "units:5": [{ action: "click", role: "button", name: "Add to credit balance" }] }, updatedAt: "" });
  return r;
};

describe("real billing pages", () => {
  it("typed-amount vendors take offers from the catalogue, not page text", async () => {
    const events: string[] = [];
    const adapter = new LadderVendorAdapter({ provider: "openai", billingOrigin: ORIGIN, pricingPath: "/billing", registry: new InMemoryAdapterRegistry(), catalogueOffers: [offer5], onEvent: (t) => events.push(t) });
    const offers = await adapter.discoverOffers(billingPage({ checkoutText: "", confirmVisible: false }), { resource: "usd_balance", amount: 1 });
    expect(offers).toEqual([offer5]);
    expect(events).toEqual(["OFFERS_FROM_CATALOGUE"]);
  });

  it("aborts before submit when the only price it can read is below the package (e.g. a $0.00 balance)", async () => {
    const adapter = new LadderVendorAdapter({ provider: "openai", billingOrigin: ORIGIN, pricingPath: "/billing", registry: await registryWith() });
    const page = billingPage({ checkoutText: "Credit balance $0.00\nConfirm payment", confirmVisible: true });
    await page.goto(`${ORIGIN}/billing`);
    await expect(adapter.stagePurchase(page, offer5)).rejects.toMatchObject({ code: "STAGED_AMOUNT_BELOW_PACKAGE" });
  });

  it("stages when the checkout shows the package total", async () => {
    const adapter = new LadderVendorAdapter({ provider: "openai", billingOrigin: ORIGIN, pricingPath: "/billing", registry: await registryWith() });
    const page = billingPage({ checkoutText: "Add $5.00 to your credit balance\nConfirm payment", confirmVisible: true });
    await page.goto(`${ORIGIN}/billing`);
    const staged = await adapter.stagePurchase(page, offer5);
    expect(staged).toMatchObject({ amount: 5, billingPeriod: "one_time", autoRenew: false });
  });

  it("config: OpenAI and Higgsfield use catalogue offers", () => {
    const up = loadUpstreams(undefined, {});
    expect(up["openai"]?.purchase?.offersFrom).toBe("catalogue");
    expect(up["higgsfield"]?.billingOrigin).toBe("https://higgsfield.ai");
    expect(up["higgsfield"]?.purchase?.offersFrom).toBe("catalogue");
    expect(up["higgsfield"]?.offers).toEqual([
      expect.objectContaining({ productId: "higgsfield_credits_100", unitsGranted: 100, price: 6.25 }),
      expect.objectContaining({ productId: "higgsfield_credits_200", unitsGranted: 200, price: 12 }),
      expect.objectContaining({ productId: "higgsfield_credits_500", unitsGranted: 500, price: 26 }),
    ]);
  });

  it("classifies the documented Higgsfield insufficient-credits body", () => {
    const r = classifyFailure({ status: 402, code: "insufficient_credits", required_credits: 3200 }, { provider: "higgsfield" });
    expect(r.blocker).toMatchObject({ type: "INSUFFICIENT_CREDITS", resource: "image_credits", required: 3200 });
  });

  it("reads a labelled SPA credit balance from a vendor-specific balance element", async () => {
    const adapter = new LadderVendorAdapter({
      provider: "higgsfield",
      billingOrigin: ORIGIN,
      accountPath: "/pricing",
      balanceSelectors: ['[data-testid="credit-balance"]'],
      registry: new InMemoryAdapterRegistry(),
    });
    const page = billingPage({ checkoutText: "", confirmVisible: false });
    const originalQuery = page.queryAllText;
    page.queryAllText = async (selector) =>
      selector === '[data-testid="credit-balance"]' ? ["Credits 0"] : originalQuery(selector);
    const result = await adapter.verifyEntitlement(page, { resource: "image_credits", amount: 1 });
    expect(result).toMatchObject({ confirmed: false, balanceAfter: 0, resource: "image_credits" });
  });
});
