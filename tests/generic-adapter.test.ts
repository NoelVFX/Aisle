import { describe, it, expect } from "vitest";
import {
  GenericVendorAdapter,
  detectAutoRenew,
  detectBillingPeriod,
  extractBalance,
  extractPrice,
  extractUnits,
  parseOffersFromText,
  runSlowLane,
} from "../src/index.js";
import { MockBrowserProvider, MockVendorSite } from "../src/slow-lane/adapters/mock-vendor-site.js";
import { ScriptedComputerUseAgent } from "../src/slow-lane/computer-use.js";
import { makeRequest, SECRET } from "./fixtures.js";

const PROVIDER = "generic-vendor";
const ORIGIN = "https://shop.mock-slow-vendor.test";

describe("generic parsing heuristics", () => {
  it("extracts price and units from noisy text", () => {
    expect(extractPrice("Pro plan — $19.99 / mo")).toBe(19.99);
    expect(extractUnits("Includes 5,000 credits per month")).toBe(5000);
  });

  it("parses offers and flags subscriptions", () => {
    const text = ["Starter  1,000 credits  $5", "Growth  5,000 credits  $20", "Pro 20,000 credits $70 / month", "Footer"].join("\n");
    const offers = parseOffersFromText(text);
    expect(offers.map((o) => o.unitsGranted)).toEqual([1000, 5000, 20000]);
    expect(offers[1]?.productId).toBe("gen_5000_20");
    expect(offers[2]?.billing).toBe("subscription");
  });

  it("reads the balance from a balance line, not the first credit count on the page", () => {
    const account = "Plan: Pro — includes 5,000 credits/month\nCredit balance: 0 credits";
    expect(extractBalance(account)).toBe(0);
    expect(extractBalance("Plan: Pro — 5,000 credits/month")).toBeUndefined();
  });

  it("detects billing period and auto-renew on a checkout page", () => {
    expect(detectBillingPeriod("One-time purchase")).toBe("one_time");
    expect(detectBillingPeriod("Billed monthly")).toBe("subscription");
    expect(detectAutoRenew("No auto-renew")).toBe(false);
    expect(detectAutoRenew("Auto-renew: on")).toBe(true);
  });
});

describe("generic adapter — end to end (no vendor-specific code)", () => {
  const req = () => makeRequest({ provider: PROVIDER, origin: ORIGIN, productId: "gen_5000_20" });

  it("discovers, stages the chosen package, buys, verifies", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const result = await runSlowLane(req(), {
      provider: new MockBrowserProvider(site),
      adapter: new GenericVendorAdapter({ provider: PROVIDER, origin: ORIGIN }),
      mandateSecret: SECRET,
    });
    expect(site.purchaseClicks).toBe(1);
    expect(site.stagedProductId).toBe("credits_5000");
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });

  it("falls back to the resolver when pricing isn't immediately visible", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, failDiscoverUntilAssisted: true });
    const agent = new ScriptedComputerUseAgent([{ type: "click", x: 100, y: 200 }, { type: "done", success: true }]);
    const result = await runSlowLane(req(), {
      provider: new MockBrowserProvider(site),
      adapter: new GenericVendorAdapter({ provider: PROVIDER, origin: ORIGIN }),
      agent,
      mandateSecret: SECRET,
    });
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });

  it("does not falsely report ALREADY_COVERED from a plan description", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const result = await runSlowLane(req(), {
      provider: new MockBrowserProvider(site),
      adapter: new GenericVendorAdapter({ provider: PROVIDER, origin: ORIGIN }),
      mandateSecret: SECRET,
    });
    expect(result.alreadyCovered).toBe(false);
  });
});
