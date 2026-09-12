/**
 * The spine, end to end, against a mock vendor with purchase tools (fast lane).
 *   npm run demo
 *
 * 402 → classify → freeze checkpoint (origin from config) → entitlement check →
 * quote → policy gate → signed mandate → (approval) → purchase → verify → replay.
 */

import { classifyFailure } from "./classifier.js";
import { freezeCheckpoint, lockOrigin } from "./core/checkpoint.js";
import { buildQuote } from "./quote/quote.js";
import { gate, InMemorySpendLedger, loadLimits } from "./policy/policy.js";
import { signMandate } from "./mandate/mandate.js";
import { runFastLane } from "./fast-lane/executor.js";
import { MOCK_CATALOGUE, MockWebMcpVendor } from "./mock/mock-vendor.js";

// upstreams.json — the root of trust for origins.
const UPSTREAM = { canonicalOrigin: "https://api.mock-image-api.test", billingOrigin: "https://api.mock-image-api.test" };
const PROVIDER = "mockvendor";

async function main(): Promise<void> {
  const vendor = new MockWebMcpVendor({ provider: PROVIDER, origin: UPSTREAM.canonicalOrigin, startingBalance: 0 });
  const limits = loadLimits();
  const spend = new InMemorySpendLedger();
  const log = (type: string, detail: unknown = "") => console.log(`  • ${type}`, detail === "" ? "" : JSON.stringify(detail));

  // 1. The blocked tool call.
  const toolError = { status: 402, code: "insufficient_credits", required_credits: 3200 };
  const classified = classifyFailure(toolError, { provider: PROVIDER });
  log("TOOL_CALL_FAILED", { type: classified.classification, recoverable: classified.recoverable });

  // 2. Freeze the checkpoint. Origin from config, never from the error.
  const checkpoint = freezeCheckpoint({
    taskId: "task_hero_images",
    toolCallId: "call_img_2",
    tool: "mockvendor__generate_image",
    arguments: { prompt: "hero image #2, cinematic, 16:9", n: 1 },
    origin: lockOrigin(PROVIDER, UPSTREAM),
    blocker: classified.blocker,
  });
  log("CHECKPOINT_FROZEN", { origin: checkpoint.origin.billingOrigin });

  // 3. Quote from the vendor's catalogue and a fresh balance read.
  const outcome = buildQuote({
    checkpoint,
    current: null,
    offers: MOCK_CATALOGUE.map((c) => ({
      productId: c.productId, label: `${c.units.toLocaleString("en-US")} credits`, unitsGranted: c.units,
      price: c.price, currency: "USD", billing: "one_time", autoRenew: false,
    })),
    perPurchaseCeiling: limits.perPurchase,
    contextNote: "3 hero images",
  });
  if (outcome.kind !== "QUOTE") throw new Error(`No purchase needed or possible: ${outcome.kind}`);
  log("QUOTE_CREATED", { price: outcome.quote.price, units: outcome.quote.unitsGranted, reason: outcome.quote.reason });

  // 4. Policy gate.
  const verdict = gate(outcome.quote, checkpoint, await spend.get(checkpoint.taskId, "demo-user"), limits);
  if (!verdict.ok) throw new Error(verdict.message);
  log("POLICY_PASSED");

  // 5. Signed mandate → one human tap (simulated) → fast lane.
  const mandate = signMandate(outcome.quote, { taskId: checkpoint.taskId, recoveryJobId: "job_demo", userId: "demo-user" });
  log("MANDATE_SIGNED", { cap: mandate.maximumAmount });
  log("APPROVAL_GRANTED");

  const result = await runFastLane({ checkpoint, quote: outcome.quote, mandate }, { session: vendor, emit: ({ type, ...rest }) => log(type, rest) });
  await spend.addSpend(checkpoint.taskId, "demo-user", outcome.quote.price);

  console.log("\n── Fast lane complete ──");
  console.log("verified balance  :", result.verifiedEntitlement.balance);
  console.log("resume key        :", result.resumeToken.id);
  console.log("replay            :", result.resumeToken.resumeAction.tool, JSON.stringify(result.resumeToken.resumeAction.arguments));
  console.log("\n→ The gateway replays the blocked call with the same arguments; the agent never saw a failure.");
}

main().catch((err) => {
  console.error("Fast lane failed:", err);
  process.exitCode = 1;
});
