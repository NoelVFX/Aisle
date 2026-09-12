/**
 * `npm run vendor:studio [-- --no-tunnel]`
 * Starts the Studio demo vendor, exposes it via a cloudflared quick tunnel,
 * stores the demo login in Steel's credentials vault and writes
 * .aisle/studio.json for the Aisle gateway.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Steel from "steel-sdk";
import { startStudio, type StudioHandle } from "./server.js";
import { createStripeApi } from "./stripe.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envPath = join(repoRoot, ".env");
const stateDir = join(repoRoot, ".aisle");
const statePath = join(stateDir, "studio.json");

function loadEnv(): void {
  if (!existsSync(envPath)) return;
  try {
    // loadEnvFile does not override variables already set in the environment.
    (process as unknown as { loadEnvFile(p: string): void }).loadEnvFile(envPath);
  } catch (err) {
    console.warn(`[studio] could not load .env: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface SavedState {
  apiKey?: string;
  login?: { email?: string; password?: string };
}

function readSaved(): SavedState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as SavedState;
  } catch {
    return {};
  }
}

function startTunnel(localUrl: string): Promise<{ child: ChildProcess; publicUrl: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("cloudflared", ["tunnel", "--url", localUrl, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = false;
    const finish = (err: Error | undefined, publicUrl?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        child.kill();
        reject(err);
      } else resolvePromise({ child, publicUrl: publicUrl ?? "" });
    };
    const timer = setTimeout(() => finish(new Error("cloudflared did not report a tunnel URL within 60s")), 60_000);
    const onData = (buf: Buffer): void => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString("utf8"));
      if (m) finish(undefined, m[0]);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => finish(new Error(`failed to start cloudflared: ${err.message}`)));
    child.on("exit", (code) => finish(new Error(`cloudflared exited early (code ${String(code)})`)));
  });
}

async function waitForHealth(publicUrl: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${publicUrl}/healthz`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return true;
    } catch {
      // DNS for fresh trycloudflare hosts can take a while; keep retrying.
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

async function storeSteelCredentials(origin: string, email: string, password: string): Promise<void> {
  const steelAPIKey = process.env["STEEL_API_KEY"];
  if (!steelAPIKey) {
    console.warn("[studio] STEEL_API_KEY not set; skipping Steel credentials vault.");
    return;
  }
  const client = new Steel({ steelAPIKey });
  const value = { username: email, password };
  try {
    await client.credentials.update({ origin, value });
    console.log(`[studio] Updated Steel credentials for ${origin}.`);
    return;
  } catch {
    // Not found (or update failed) — fall through to create.
  }
  try {
    await client.credentials.create({ origin, value, label: "Studio demo login" });
    console.log(`[studio] Stored Steel credentials for ${origin}.`);
  } catch (err) {
    console.warn(`[studio] WARNING: could not store Steel credentials: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  loadEnv();
  const noTunnel = process.argv.includes("--no-tunnel");

  const secretKey = process.env["STRIPE_SECRET_KEY"];
  if (!secretKey || !secretKey.startsWith("sk_test_")) {
    console.error(
      "[studio] STRIPE_SECRET_KEY is missing or not a test-mode key. Set STRIPE_SECRET_KEY=sk_test_... in .env (live keys are refused).",
    );
    process.exit(1);
  }
  const stripe = createStripeApi(secretKey);

  mkdirSync(stateDir, { recursive: true });
  const saved = readSaved();
  const apiKey = saved.apiKey ?? `sk_studio_${randomBytes(16).toString("hex")}`;
  const email = saved.login?.email ?? "demo@studio.test";
  const password = saved.login?.password ?? randomBytes(12).toString("base64url");

  const handle: StudioHandle = await startStudio({ stripe, apiKey, login: { email, password } });
  const localUrl = handle.url;
  console.log(`[studio] Listening on ${localUrl}`);

  let tunnel: ChildProcess | undefined;
  let publicUrl = localUrl;
  if (!noTunnel) {
    const t = await startTunnel(localUrl);
    tunnel = t.child;
    publicUrl = t.publicUrl;
    console.log(`[studio] Tunnel up at ${publicUrl}; waiting for DNS...`);
    if (!(await waitForHealth(publicUrl))) {
      console.warn(
        "[studio] WARNING: could not reach the tunnel from this machine within 60s (local DNS may not resolve fresh trycloudflare hosts). Continuing; Steel's cloud browser usually resolves it fine.",
      );
    }
  }
  handle.setPublicUrl(publicUrl);

  writeFileSync(
    statePath,
    JSON.stringify({ localUrl, publicUrl, apiKey, login: { email, password }, startedAt: new Date().toISOString() }, null, 2) + "\n",
    { mode: 0o600 },
  );

  await storeSteelCredentials(publicUrl, email, password);

  console.log("");
  console.log(`Studio demo vendor running (Stripe test mode)`);
  console.log(`  Local:      ${localUrl}`);
  console.log(`  Public:     ${publicUrl}`);
  console.log(`  Billing:    ${publicUrl}/billing`);
  console.log(`  Playground: ${publicUrl}/playground`);
  console.log(`  Login:      ${email} (password stored in Steel credentials and .aisle/studio.json)`);
  console.log(`  API key:    stored in .aisle/studio.json`);
  console.log("");
  console.log("Restart the Aisle gateway so it picks up .aisle/studio.json");

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[studio] Shutting down...");
    tunnel?.kill();
    try {
      rmSync(statePath, { force: true });
    } catch {
      // ignore
    }
    await handle.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  tunnel?.on("exit", (code) => {
    if (!shuttingDown) console.warn(`[studio] WARNING: cloudflared exited (code ${String(code)}); public URL is down.`);
  });
}

main().catch((err: unknown) => {
  console.error(`[studio] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
