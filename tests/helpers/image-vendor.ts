/**
 * Test-only credit-metered vendor for gateway tests. Not shipped: the product
 * talks to real vendors only (upstreams.json). Each image costs 1,067 credits;
 * packs are c1000 ($5), c5000 ($20), c25000 ($80).
 */

import { z } from "zod";
import { loadUpstreams, type UpstreamEntry, type Upstreams, type VendorTool } from "../../src/gateway/upstreams.js";
import type { SteelPurchaser } from "../../src/gateway/recovery.js";
import type { PurchaseOffer } from "../../src/types.js";
import { registerVendorRules } from "../../src/classifier.js";

export const IMAGE_COST = 1067;
export const VENDOR_ORIGIN = "https://shop.vendor.test";

registerVendorRules("imagevendor", [
  {
    test: (e) => e.code === "insufficient_credits",
    type: "INSUFFICIENT_CREDITS",
    resource: "image_credits",
    required: (e) => {
      const v = e.body !== null && typeof e.body === "object" ? (e.body as Record<string, unknown>)["required_credits"] : undefined;
      return typeof v === "number" ? v : undefined;
    },
  },
]);

export const IMAGE_OFFERS: PurchaseOffer[] = [
  { productId: "c1000", label: "1,000 credits", unitsGranted: 1000, price: 5, currency: "USD", billing: "one_time", autoRenew: false },
  { productId: "c5000", label: "5,000 credits", unitsGranted: 5000, price: 20, currency: "USD", billing: "one_time", autoRenew: false },
  { productId: "c25000", label: "25,000 credits", unitsGranted: 25000, price: 80, currency: "USD", billing: "one_time", autoRenew: false },
];

/** `imagevendor` upstream. `purchase` routes approval to the purchasers; `mcp` adds a fast-lane endpoint. */
export function imageVendorEntry(opts: { origin?: string; purchase?: boolean; mcp?: boolean } = {}): UpstreamEntry {
  const origin = opts.origin ?? VENDOR_ORIGIN;
  return {
    description: "Test image vendor",
    canonicalOrigin: origin,
    billingOrigin: origin,
    billingUrl: `${origin}/pricing`,
    resource: "image_credits",
    ...(opts.purchase || opts.mcp
      ? {
          purchase: {
            mode: "slow-lane" as const,
            realMoney: false,
            pricingPath: "/pricing",
            accountPath: "/account",
            ...(opts.mcp ? { mcpUrl: `${origin}/mcp` } : {}),
          },
        }
      : {}),
    offers: IMAGE_OFFERS,
  };
}

/** The real catalogue (openai, openrouter, higgsfield) plus the test vendor. */
export function upstreamsWith(entry: UpstreamEntry): Upstreams {
  return Object.freeze({ ...loadUpstreams(undefined, {}), imagevendor: Object.freeze(entry) });
}

export class FakeImageVendor {
  balance: number;
  generated = 0;

  constructor(startingBalance = 0) {
    this.balance = startingBalance;
  }

  credit(units: number): void {
    this.balance += units;
  }

  tool(): VendorTool {
    return {
      name: "imagevendor__generate_image",
      namespace: "imagevendor",
      description: "Generate one image (test vendor).",
      inputShape: { prompt: z.string() },
      call: async (args) => {
        if (this.balance < IMAGE_COST) {
          return { ok: false, status: 402, headers: {}, body: { code: "insufficient_credits", required_credits: IMAGE_COST, balance: this.balance } };
        }
        this.balance -= IMAGE_COST;
        this.generated += 1;
        return {
          ok: true,
          text: JSON.stringify({ url: `https://cdn.vendor.test/img/${this.generated}.png`, prompt: String(args["prompt"] ?? ""), credits_remaining: this.balance }),
        };
      },
    };
  }
}

/** A SteelPurchaser that credits the vendor with the approved pack and reports it verified. */
export function creditingPurchaser(vendor: FakeImageVendor, seen?: Array<{ realMoneyAllowed: boolean; billingOrigin: string }>): SteelPurchaser {
  return {
    async purchase({ job, upstream, realMoneyAllowed }) {
      seen?.push({ realMoneyAllowed, billingOrigin: upstream.billingOrigin });
      vendor.credit(job.quote!.unitsGranted);
      return {
        outcome: "verified",
        result: { lane: "slow", purchaseId: "pur_1", alreadyCovered: false, verifiedEntitlement: { balance: vendor.balance } as never, resumeToken: {} as never },
      };
    },
  };
}
