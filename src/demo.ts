/**
 * Runnable end-to-end demo of the fast lane against a mock WebMCP vendor.
 *   npm run demo
 *
 * Shows: 402 → WebMCP detected → guarded → purchased → verified → resume token.
 */

import { runFastLane } from "./fast-lane/executor.js";
import { MockWebMcpVendor } from "./mock/mock-vendor.js";
import type { FastLaneRequest } from "./types.js";

const PROVIDER = "mock-image-api";
const ORIGIN = "https://api.mock-image-api.test";

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
      origin: {
        provider: PROVIDER,
        canonicalOrigin: ORIGIN,
        source: "task_configuration",
        lockedAt: new Date().toISOString(),
      },
      failure: { type: "INSUFFICIENT_CREDITS", rawError: { status: 402 } },
    },
    quote: {
      provider: PROVIDER,
      purchase: {
        productId: "credits_5000",
        quantity: 1,
        credits: 5000,
        price: 20,
        currency: "USD",
      },
      billing: "one_time",
      autoRenew: false,
      reason: "3 hero images require ~3,200 credits; smallest package is 5,000.",
    },
    mandate: {
      mandateId: "mnd_001",
      taskId: "task_hero_images",
      origin: ORIGIN,
      provider: PROVIDER,
      productId: "credits_5000",
      maximumAmount: 50,
      currency: "USD",
      billingType: "one_time",
      autoRenew: false,
      expiresAt,
      nonce: "nonce_abc123",
      signature: "sig_demo_ok",
    },
  };
}

async function main(): Promise<void> {
  const vendor = new MockWebMcpVendor({
    provider: PROVIDER,
    origin: ORIGIN,
    startingBalance: 0,
  });

  const result = await runFastLane(buildRequest(), {
    session: vendor,
    emit: (e) => console.log(`  • ${e.type}`, summarize(e)),
  });

  console.log("\n── Fast lane complete ──");
  console.log("purchaseId        :", result.purchaseId);
  console.log("verified balance  :", result.verifiedEntitlement.balance);
  console.log("resume token      :", result.resumeToken.id);
  console.log("replay tool       :", result.resumeToken.resumeAction.tool);
  console.log("replay arguments  :", JSON.stringify(result.resumeToken.resumeAction.arguments));
  console.log("\n→ Host now replays the failed tool call and Hermes continues.");
}

function summarize(e: Record<string, unknown>): string {
  const { type, ...rest } = e;
  return Object.keys(rest).length ? JSON.stringify(rest) : "";
}

main().catch((err) => {
  console.error("Fast lane failed:", err);
  process.exitCode = 1;
});
