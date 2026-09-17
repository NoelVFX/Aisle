/**
 * Sign a vendor's local browser profile in, once, by hand.
 *   npm run login -- openrouter                       (a configured vendor)
 *   npm run login -- https://any-saas.example.com/    (any vendor, no config)
 *
 * Opens a headed local Chromium on the vendor's page in that vendor's PERSISTENT
 * profile. Log in there, then press Enter. The context is closed (which flushes
 * cookies/localStorage to the userDataDir) and the (user, vendor) binding is saved
 * under `.aisle/profiles`, where the slow lane and the on-demand top-up restore it.
 *
 * Your password never enters this process: you type it into the browser window.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { LocalBrowserProvider } from "../slow-lane/local-provider.js";
import { FileProfileStore } from "../slow-lane/profiles.js";
import { loadUpstreams } from "./upstreams.js";
import { adHocUpstream } from "../web/external-action.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) (process as unknown as { loadEnvFile(path: string): void }).loadEnvFile(ENV_FILE);

const USER_ID = "local-user"; // matches the gateway's recovery coordinator
const arg = process.argv[2] ?? "openrouter";

// A raw URL logs in an ad-hoc vendor (no config needed); otherwise it's a configured namespace.
const isUrl = /^https?:\/\//i.test(arg);
const { ns, upstream } = isUrl
  ? (() => {
      const a = adHocUpstream(arg);
      return { ns: a.provider, upstream: a.upstream };
    })()
  : (() => {
      const u = loadUpstreams()[arg];
      if (!u) {
        console.error(`Unknown vendor '${arg}'. Pass a configured name or a full https URL.`);
        process.exit(1);
      }
      return { ns: arg, upstream: u };
    })();

const stateDir = join(ROOT, ".aisle");
const profilesDir = join(stateDir, "profiles");
const store = new FileProfileStore(profilesDir);
const provider = new LocalBrowserProvider({ profilesDir, headed: true });

const session = await provider.createSession({ provider: ns });
const mount = session.profile;
if (!mount) {
  await session.close();
  throw new Error("No profile directory was created for this session.");
}
await store.save({ userId: USER_ID, provider: ns, profileId: mount.profileId });

const loginUrl = isUrl
  ? arg
  : upstream.purchase?.pricingPath
    ? new URL(upstream.purchase.pricingPath, upstream.billingOrigin).toString()
    : upstream.billingOrigin;

console.log(`Opening ${ns} at ${loginUrl}.`);
console.log("Log in (and dismiss any prompts) in the browser window, then come back here.");
await session.page.goto(loginUrl).catch(() => {});

const rl = createInterface({ input: process.stdin, output: process.stdout });
await new Promise<void>((resolve) => rl.question("Press Enter once you are logged in… ", () => (rl.close(), resolve())));

await session.close(); // flushes cookies/localStorage to the userDataDir
console.log(`Saved the ${ns} browser profile. The gateway will reuse it for top-ups.`);
process.exit(0);
