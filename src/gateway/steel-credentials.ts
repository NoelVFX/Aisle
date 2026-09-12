/**
 * Store a vendor login in Steel's credentials vault (steel.md §8).
 *   npm run steel:credentials -- openrouter
 *
 * Asks for the email and password in this terminal (the password is not echoed)
 * and sends them straight to Steel, stored against the vendor's billing origin
 * from upstreams.json. In a purchase session Steel types them into the sign-in
 * form itself: Aisle's code, logs and models never see them, and nothing is
 * written to disk here. Vendors with `purchase.steelCredentials: true` use it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Steel from "steel-sdk";
import { loadUpstreams } from "./upstreams.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) (process as unknown as { loadEnvFile(path: string): void }).loadEnvFile(ENV_FILE);

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Print the prompt once, then swallow the echo of every keystroke.
      const r = rl as unknown as { _writeToOutput: (s: string) => void };
      let prompted = false;
      r._writeToOutput = (s) => {
        if (!prompted) process.stdout.write(s);
        prompted = true;
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

const ns = process.argv[2];
const upstream = ns ? loadUpstreams()[ns] : undefined;
if (!ns || !upstream) {
  console.error("Usage: npm run steel:credentials -- <vendor>   (e.g. openrouter)");
  process.exit(1);
}
const apiKey = process.env["STEEL_API_KEY"];
if (!apiKey) {
  console.error("STEEL_API_KEY is missing from .env.");
  process.exit(1);
}

const origin = upstream.billingOrigin;
console.log(`Storing a ${ns} login in Steel's credentials vault for ${origin}.`);
if (!upstream.purchase?.steelCredentials) {
  console.log(`Note: upstreams.json has no purchase.steelCredentials for ${ns}; Aisle won't ask Steel to use it until that is set.`);
}
const username = await ask("Email: ");
const password = await ask("Password (hidden): ", true);
if (!username || !password) {
  console.error("Email and password are both required. Nothing was stored.");
  process.exit(1);
}

const client = new Steel({ steelAPIKey: apiKey });
const value = { username, password };
try {
  await client.credentials.update({ origin, value });
  console.log(`Updated the Steel credential for ${origin}.`);
} catch {
  await client.credentials.create({ origin, value, label: `Aisle ${ns} login` });
  console.log(`Stored a Steel credential for ${origin}.`);
}
console.log(
  "Restart the gateway. Purchase sessions for this vendor now sign in with it. If the vendor asks for an " +
    "emailed code or a Google/GitHub sign-in, Aisle still hands that one step to you in the viewer.",
);
