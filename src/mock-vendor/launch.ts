/**
 * Start the mock vendor website and expose it to Steel's cloud browser.
 *   npm run mock:vendor            # site on :8080 + cloudflared quick tunnel
 *   npm run mock:vendor -- --no-tunnel
 *
 * Writes `.aisle/mock-vendor.json` { localUrl, publicUrl }. The gateway reads it
 * at startup, so start this BEFORE starting Codex. The public URL becomes the
 * mock vendor's billing origin through upstreams.json — operator config, never
 * a value from a tool result.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockVendor } from "./server.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STATE_DIR = join(ROOT, ".aisle");
const INFO_FILE = join(STATE_DIR, "mock-vendor.json");
const port = Number(process.env["MOCK_VENDOR_PORT"] ?? 8080);
const tunnel = !process.argv.includes("--no-tunnel");

const site = await startMockVendor({ port });
console.log(`[mock-vendor] local  ${site.url}`);

let child: ChildProcess | undefined;
let publicUrl: string | undefined;

if (tunnel) {
  child = spawn("cloudflared", ["tunnel", "--url", site.url, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  publicUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cloudflared did not print a tunnel URL within 60s")), 60_000);
    const onData = (buf: Buffer) => {
      const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    child!.stdout?.on("data", onData);
    child!.stderr?.on("data", onData);
    child!.once("exit", (code) => reject(new Error(`cloudflared exited with code ${code}`)));
  });

  // DNS for a fresh quick tunnel takes a few seconds to resolve.
  for (let i = 0; i < 30; i++) {
    const ok = await fetch(`${publicUrl}/pricing`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`[mock-vendor] public ${publicUrl}`);
}

mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(INFO_FILE, JSON.stringify({ localUrl: site.url, publicUrl, startedAt: new Date().toISOString() }, null, 2));
console.log(`[mock-vendor] wrote ${INFO_FILE}. Start (or restart) Codex now so the gateway picks it up.`);
console.log("[mock-vendor] Ctrl+C to stop.");

const shutdown = async () => {
  child?.kill();
  rmSync(INFO_FILE, { force: true });
  await site.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
