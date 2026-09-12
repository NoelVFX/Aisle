/**
 * Runnable end-to-end demo of the SLOW lane against a mock vendor website.
 *   npm run demo:slow
 *
 * Shows: no WebMCP → browser session → pricing → checkout → confirm → verify →
 * profile saved → resume token. Uses the mock browser/adapter so it runs with
 * no Steel key and no real browser. Swap MockBrowserProvider for
 * SteelBrowserProvider (STEEL_API_KEY) and MockVendorAdapter for a real adapter
 * to drive an actual site.
 */

import { runSlowLane } from "./slow-lane/executor.js";
import { InMemoryProfileStore } from "./slow-lane/profiles.js";
import {
  MockBrowserProvider,
  MockVendorAdapter,
  MockVendorSite,
} from "./slow-lane/adapters/mock-vendor-site.js";
import type { FastLaneRequest } from "./types.js";

const PROVIDER = "mock-slow-vendor";
const ORIGIN = "https://shop.mock-slow-vendor.test";

function buildRequest(): FastLaneRequest {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return {
    checkpoint: {
      taskId: "task_hero_images",
      agentId: "hermes",
      originalGoal: "Generate three hero images for the landing page.",
      failedToolCall: {
        id: "call_img_2",
        tool: "generate_image",
        arguments: { prompt: "hero image #2, cinematic, 16:9", n: 1 },
      },
      origin: { provider: PROVIDER, canonicalOrigin: ORIGIN, source: "task_configuration", lockedAt: new Date().toISOString() },
      failure: { type: "INSUFFICIENT_CREDITS", rawError: { status: 402 } },
    },
    quote: {
      provider: PROVIDER,
      purchase: { productId: "credits_5000", quantity: 1, credits: 5000, price: 20, currency: "USD" },
      billing: "one_time",
      autoRenew: false,
      reason: "3 hero images require ~3,200 credits; smallest sufficient package is 5,000.",
    },
    requirement: { resource: "credits", amount: 3200 },
    mandate: {
      mandateId: "mnd_slow_001",
      taskId: "task_hero_images",
      origin: ORIGIN,
      provider: PROVIDER,
      productId: "credits_5000",
      maximumAmount: 50,
      currency: "USD",
      billingType: "one_time",
      autoRenew: false,
      expiresAt,
      nonce: "nonce_slow_abc",
      signature: "sig_demo_ok",
    },
  };
}

async function main(): Promise<void> {
  const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
  const provider = new MockBrowserProvider(site);
  const adapter = new MockVendorAdapter(site);
  const profiles = new InMemoryProfileStore();

  const result = await runSlowLane(buildRequest(), {
    provider,
    adapter,
    profiles,
    emit: (e) => console.log(`  • ${e.type}`, summarize(e)),
  });

  console.log("\n── Slow lane complete ──");
  console.log("lane              :", result.lane);
  console.log("purchaseId        :", result.purchaseId);
  console.log("verified balance  :", result.verifiedEntitlement.balance);
  console.log("resume token      :", result.resumeToken.id);
  console.log("replay tool       :", result.resumeToken.resumeAction.tool);
  console.log("saved profile     :", (await profiles.load(PROVIDER)) ? "yes" : "no");
  console.log("\n→ Host now replays the failed tool call and Hermes continues.");
}

function summarize(e: Record<string, unknown>): string {
  const { type, ...rest } = e;
  return Object.keys(rest).length ? JSON.stringify(rest) : "";
}

main().catch((err) => {
  console.error("Slow lane failed:", err);
  process.exitCode = 1;
});
