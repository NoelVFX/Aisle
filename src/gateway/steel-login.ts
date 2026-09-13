/**
 * Log a Steel profile in to a vendor once, by hand (steel.md §6, §16.3).
 *   npm run steel:login -- openai
 *
 * Opens an INTERACTIVE Steel browser on the vendor's billing page and opens its
 * live view in your browser. Log in there. Press Enter here when you can see the
 * billing page. The session is released, Steel persists the profile (READY),
 * and the (user, vendor) binding is stored in `.aisle/profiles`, where the
 * gateway's slow lane restores it.
 *
 * Your password never enters this process: you type it into the Steel browser.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Steel from "steel-sdk";
import { SteelBrowserProvider, stealthFromEnv } from "../slow-lane/steel-provider.js";
import { FileProfileStore } from "../slow-lane/profiles.js";
import { loadUpstreams } from "./upstreams.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) (process as unknown as { loadEnvFile(path: string): void }).loadEnvFile(ENV_FILE);

const USER_ID = "local-user"; // matches the gateway's recovery coordinator
const ns = process.argv[2] ?? "openai";
const upstream = loadUpstreams()[ns];
if (!upstream) {
  console.error(`Unknown upstream '${ns}'.`);
  process.exit(1);
}

const store = new FileProfileStore(join(ROOT, ".aisle", "profiles"));
const stored = await store.load(USER_ID, ns);
const loginStealth = stealthFromEnv();
const provider = new SteelBrowserProvider({
  ...(process.env["AISLE_STEEL_PROXY_CAPTCHA"] === "1" ? {} : { useProxy: false, solveCaptcha: false }),
  // Same fingerprint the purchase session will restore, or the login won't hold.
  ...(loginStealth ? { stealth: loginStealth } : {}),
  sessionTimeoutMs: 15 * 60_000,
  sessionOptions: { debugConfig: { interactive: true } },
});
const client = new Steel({ steelAPIKey: process.env["STEEL_API_KEY"] ?? "" });

console.log(stored ? `Restoring the existing ${ns} profile…` : `Creating a new Steel profile for ${ns}…`);
const session = await provider.createSession(stored ? { provider: ns, profile: stored } : { provider: ns });
const mount = session.profile;
if (!mount) {
  await session.close();
  throw new Error("Steel returned no profile for this session; nothing would be remembered.");
}
const binding = {
  userId: USER_ID,
  provider: ns,
  profileId: mount.profileId,
  ...(mount.dedicatedIpId ? { dedicatedIpId: mount.dedicatedIpId } : {}),
};
await store.save({ ...stored, ...binding });

try {
  const details = await client.sessions.retrieve(session.sessionId);
  const liveUrl = details.debugUrl;
  await session.page.goto(upstream.billingUrl ?? upstream.billingOrigin);

  console.log(`\nSteel browser (interactive): ${liveUrl}`);
  if (process.platform === "darwin") spawn("open", [liveUrl], { stdio: "ignore", detached: true }).unref();
  console.log(`1. Log in to ${ns} inside that Steel browser tab.`);
  console.log(`2. When you can see ${upstream.billingUrl ?? upstream.billingOrigin}, come back here and press Enter.\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => rl.question("Press Enter when logged in… ", () => resolve()));
  rl.close();

  const url = session.page.currentUrl();
  console.log(`Steel browser is on: ${url}`);
} finally {
  await session.close(); // release starts the profile write
}

console.log("Waiting for Steel to persist the profile…");
const status = await provider.waitForProfileReady(mount.profileId);
console.log(`Profile status: ${status}`);
if (status === "READY") {
  await store.save({ ...binding, lastVerifiedAt: new Date().toISOString() });
  console.log(`Saved. The gateway will restore this ${ns} login for purchases.`);
} else {
  console.log("The profile did not reach READY; try again before relying on it.");
  process.exitCode = 1;
}
