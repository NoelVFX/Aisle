import { describe, it, expect } from "vitest";
import {
  GenericVendorAdapter,
  parseOffersFromText,
  extractPrice,
  extractUnits,
  runSlowLane,
} from "../src/index.js";
import {
  MockBrowserProvider,
  MockVendorSite,
} from "../src/slow-lane/adapters/mock-vendor-site.js";
import { ScriptedComputerUseAgent } from "../src/slow-lane/computer-use.js";
import type { FastLaneRequest } from "../src/types.js";

const PROVIDER = "generic-vendor";
const ORIGIN = "https://shop.mock-slow-vendor.test";

describe("generic parsing heuristics", () => {
  it("extracts price and units from noisy text", () => {
    expect(extractPrice("Pro plan — $19.99 / mo")).toBe(19.99);
    expect(extractUnits("Includes 5,000 credits per month")).toBe(5000);
  });

  it("parses multiple offers from a pricing blob", () => {
    const text = [
      "Starter  1,000 credits  $5",
      "Growth  5,000 credits  $20",
      "Scale  20,000 credits  $70",
      "Footer: contact sales", // no price+units → ignored
    ].join("\n");
    const offers = parseOffersFromText(text);
    expect(offers.map((o) => o.units)).toEqual([1000, 5000, 20000]);
    expect(offers.map((o) => o.price)).toEqual([5, 20, 70]);
    expect(offers[1]?.productId).toBe("gen_5000_20");
  });
});

function makeRequest(): FastLaneRequest {
  return {
    checkpoint: {
      taskId: "task_g",
      agentId: "hermes",
      originalGoal: "Generate hero images.",
      failedToolCall: { id: "call_2", tool: "generate_image", arguments: { prompt: "hero #2" } },
      origin: { provider: PROVIDER, canonicalOrigin: ORIGIN, source: "task_configuration", lockedAt: new Date().toISOString() },
      failure: { type: "INSUFFICIENT_CREDITS", rawError: { status: 402 } },
    },
    quote: {
      provider: PROVIDER,
      purchase: { productId: "gen_5000_20", quantity: 1, credits: 5000, price: 20, currency: "USD" },
      billing: "one_time",
      autoRenew: false,
      reason: "needs credits",
    },
    requirement: { resource: "credits", amount: 3200 },
    mandate: {
      mandateId: "mnd_g",
      taskId: "task_g",
      origin: ORIGIN,
      provider: PROVIDER,
      productId: "gen_5000_20",
      maximumAmount: 50,
      currency: "USD",
      billingType: "one_time",
      autoRenew: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: "nonce_g",
      signature: "sig_ok",
    },
  };
}

describe("generic adapter — end to end (no vendor-specific code)", () => {
  it("discovers, buys, verifies, and resumes on the mock site", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const adapter = new GenericVendorAdapter({ provider: PROVIDER, origin: ORIGIN });
    const result = await runSlowLane(makeRequest(), {
      provider: new MockBrowserProvider(site),
      adapter,
    });
    expect(result.lane).toBe("slow");
    expect(site.purchaseClicks).toBe(1);
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });

  it("falls back to computer-use when pricing isn't immediately visible", async () => {
    const site = new MockVendorSite({
      provider: PROVIDER,
      origin: ORIGIN,
      startingBalance: 0,
      failDiscoverUntilAssisted: true,
    });
    const adapter = new GenericVendorAdapter({ provider: PROVIDER, origin: ORIGIN });
    const agent = new ScriptedComputerUseAgent([
      { type: "click", x: 100, y: 200 },
      { type: "done", success: true },
    ]);
    const result = await runSlowLane(makeRequest(), {
      provider: new MockBrowserProvider(site),
      adapter,
      agent,
    });
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });
});
