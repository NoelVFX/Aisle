/**
 * A Cloudflare quick tunnel to a local server (the same trick `npm run
 * mock:vendor` uses), so a watch link opens on a phone. Needs `cloudflared` on
 * PATH. Only token-gated /r/ routes and static assets are reachable through it.
 */

import { spawn } from "node:child_process";

export interface Tunnel {
  url: string;
  close(): void;
}

export function startTunnel(localUrl: string, timeoutMs = 60_000): Promise<Tunnel> {
  const child = spawn("cloudflared", ["tunnel", "--url", localUrl, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise<Tunnel>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cloudflared printed no tunnel URL within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const onData = (buf: Buffer) => {
      const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (!m) return;
      clearTimeout(timer);
      resolve({ url: m[0], close: () => child.kill() });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited with code ${code}`));
    });
  });
}
