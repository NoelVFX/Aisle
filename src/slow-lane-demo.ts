/**
 * The slow lane against a mock vendor website (no Steel key, no browser).
 *   npm run demo:slow
 *
 * Swap MockBrowserProvider for SteelBrowserProvider (STEEL_API_KEY) and
 * MockVendorAdapter for a real adapter to drive an actual site.
 */

import { freezeCheckpoint, lockOrigin } from "./core/checkpoint.js";
import { signMandate } from "./mandate/mandate.js";
import { runSlowLane } from "./slow-lane/executor.js";
import { InMemoryProfileStore } from "./slow-lane/profiles.js";
import { MockBrowserProvider, MockVendorAdapter, MockVendorSite } from "./slow-lane/adapters/mock-vendor-site.js";
import type { Quote } from "./types.js";

const PROVIDER = "mock-slow-vendor";
const UPSTREAM = { canonicalOrigin: "https://api.mock-slow-vendor.test", billingOrigin: "https://shop.mock-slow-vendor.test" };

async function main(): Promise<void> {
  const site = new MockVendorSite({ provider: PROVIDER, origin: UPSTREAM.billingOrigin, startingBalance: 0 });
  const profiles = new InMemoryProfileStore();

  const checkpoint = freezeCheckpoint({
    taskId: "task_hero_images",
    toolCallId: "call_img_2",
    tool: "mockslow__generate_image",
    arguments: { prompt: "hero image #2, cinematic, 16:9", n: 1 },
    origin: lockOrigin(PROVIDER, UPSTREAM),
    blocker: { type: "INSUFFICIENT_CREDITS", resource: "credits", required: 3200, confidence: "high", raw: { status: 402 } },
  });
  const quote: Quote = {
    provider: PROVIDER,
    billingOrigin: UPSTREAM.billingOrigin,
    productId: "credits_5000",
    quantity: 1,
    unitsGranted: 5000,
    price: 20,
    currency: "USD",
    billing: "one_time",
    autoRenew: false,
    reason: "3 hero images need 3,200 credits. Balance 0. Smallest package that clears it is 5,000 credits at $20.",
  };
  const mandate = signMandate(quote, { taskId: checkpoint.taskId, recoveryJobId: "job_slow", userId: "demo-user" });

  const result = await runSlowLane(
    { checkpoint, quote, mandate },
    {
      provider: new MockBrowserProvider(site),
      adapter: new MockVendorAdapter(site),
      profiles,
      emit: ({ type, ...rest }) => console.log(`  • ${type}`, Object.keys(rest).length ? JSON.stringify(rest) : ""),
    },
  );

  console.log("\n── Slow lane complete ──");
  console.log("verified balance  :", result.verifiedEntitlement.balance);
  console.log("resume key        :", result.resumeToken.id);
  console.log("saved profile     :", (await profiles.load(mandate.userId, PROVIDER)) ? "yes" : "no");
}

main().catch((err) => {
  console.error("Slow lane failed:", err);
  process.exitCode = 1;
});
