/**
 * Real slow-lane purchase against the mock vendor WEBSITE through a real Steel
 * browser, twice: a cold run (tier-3 picker → promoted adapter) and a warm run
 * (tier-2 replay, no model).
 *
 *   terminal 1: npm run mock:vendor
 *   terminal 2: npm run smoke:purchase
 *
 * Fake money only. Needs STEEL_API_KEY and OPENROUTER_INFRA_KEY in .env.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "./gateway.js";
import { loadUpstreams } from "./upstreams.js";
import { createSteelPurchaser } from "./steel-purchaser.js";
import { InMemoryIdempotencyStore } from "../fast-lane/idempotency.js";
import { FileAdapterRegistry } from "../slow-lane/adapters/recorded-adapter.js";
import type { SteelRunner } from "./recovery.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STATE_DIR = join(ROOT, ".aisle");
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) (process as unknown as { loadEnvFile(path: string): void }).loadEnvFile(ENV_FILE);

const MOCK_FILE = join(STATE_DIR, "mock-vendor.json");
if (!existsSync(MOCK_FILE)) {
  console.error("Start the mock vendor first: npm run mock:vendor");
  process.exit(1);
}
const mock = JSON.parse(readFileSync(MOCK_FILE, "utf8")) as { localUrl: string; publicUrl?: string };
if (!mock.publicUrl) {
  console.error("The mock vendor has no public URL. Run it with the tunnel: npm run mock:vendor");
  process.exit(1);
}
process.env["MOCK_VENDOR_URL"] = mock.localUrl;
process.env["MOCK_VENDOR_PUBLIC_URL"] = mock.publicUrl;

const upstreams = loadUpstreams();
const billingOrigin = upstreams["mockvendor"]!.billingOrigin;
const registry = new FileAdapterRegistry(join(STATE_DIR, "adapters"));

// Start cold unless asked to keep the recorded adapter.
if (!process.argv.includes("--keep-adapter")) rmSync(join(STATE_DIR, "adapters"), { recursive: true, force: true });

const noViewing: SteelRunner = {
  run: async () => {
    throw new Error("viewing lane not used in this smoke");
  },
};

const t0 = Date.now();
const gateway = createGateway({
  upstreams,
  steel: noViewing,
  purchaser: createSteelPurchaser({
    stateDir: STATE_DIR,
    steelProvider: { useProxy: false, solveCaptcha: false, sessionOptions: { debugConfig: { interactive: false } } },
    store: new InMemoryIdempotencyStore(),
  }),
  safeBlockMs: 500,
  pollMs: 200,
  publicUrl: () => "http://127.0.0.1",
  log: (m) => console.log(m),
  onEvent: (_job, e) =>
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${e.type} ${JSON.stringify(e.detail).slice(0, 180)}`),
  onSteelLive: (job) => console.log(`  LIVE ${job.live?.debugUrl}`),
});

const parse = (r: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> => {
  try {
    return JSON.parse(r.content[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

for (const run of [1, 2]) {
  console.log(`\n══ Run ${run} (${run === 1 ? "cold: tier-3 picker, then record" : "warm: tier-2 recorded adapter"}) ══`);
  await fetch(`${mock.localUrl}/admin/reset`, { method: "POST", body: "{}" });
  const started = Date.now();

  const first = parse(
    (await gateway.callTool("mockvendor__generate_image", { prompt: `hero image #${run}` }, { taskId: `smoke-${run}` })) as never,
  );
  if (first["status"] !== "AWAITING_APPROVAL") {
    console.log("Unexpected first result:", first);
    process.exit(1);
  }
  const job = gateway.coordinator.get(String(first["recovery_id"]))!;
  console.log(`  quote: ${job.quote?.reason}`);
  await gateway.coordinator.approve(job.id, job.mandate!.signature);

  let final = await gateway.waitForRecovery(job.id);
  for (let i = 0; i < 600 && ["AWAITING_APPROVAL", "RECOVERY_RUNNING"].includes(String(parse(final as never)["status"])); i++) {
    final = await gateway.waitForRecovery(job.id);
  }
  const body = final.content[0]?.type === "text" ? final.content[0].text : "";
  console.log(`  result (${((Date.now() - started) / 1000).toFixed(1)}s): ${final.isError ? "ERROR " : ""}${body}`);
  if (final.isError) process.exit(1);
}

const adapter = await registry.load(billingOrigin);
console.log(`\nRecorded adapter v${adapter?.version}: ${JSON.stringify(adapter?.offers)} confirm=${JSON.stringify(adapter?.confirm)}`);
