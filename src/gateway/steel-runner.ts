/**
 * The gateway's Steel step: open a real Steel browser on the vendor's billing
 * page (on the LOCKED billing origin), let the user watch it live, take a
 * screenshot through `sessions.computer`, and release.
 *
 * It does not purchase. It never runs the checkout, never consumes the mandate,
 * and uses `persistProfile: false` so a test run never writes a stored identity.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Steel from "steel-sdk";
import { SteelBrowserProvider, type SteelProviderOptions } from "../slow-lane/steel-provider.js";
import type { SteelEvidence, SteelLive, SteelRunner } from "./recovery.js";

export interface SteelRunnerOptions {
  /** Longest the session stays open for watching, unless ended from the approval page. */
  holdMs?: number;
  screenshotsDir: string;
  provider?: SteelProviderOptions;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createSteelRunner(opts: SteelRunnerOptions): SteelRunner {
  return {
    async run({ provider, billingUrl, jobId, emit, onLive, hold }): Promise<SteelEvidence> {
      const steel = new SteelBrowserProvider(opts.provider); // throws if STEEL_API_KEY is missing
      const client = new Steel({ steelAPIKey: opts.provider?.apiKey ?? process.env["STEEL_API_KEY"] ?? "" });
      const session = await steel.createSession({ provider, persistProfile: false });

      try {
        const details = await client.sessions.retrieve(session.sessionId).catch(() => undefined);
        const live: SteelLive = {
          sessionId: session.sessionId,
          debugUrl: details?.debugUrl,
          viewerUrl: session.sessionViewerUrl,
        };
        // The debug URL is an unauthenticated player; it reaches users only through the watch projection.
        emit("STEEL_SESSION_CREATED", { sessionId: live.sessionId, viewerUrl: live.viewerUrl });
        onLive(live);

        await session.page.goto(billingUrl);
        emit("PAGE_OPENED", { requested: billingUrl, url: session.page.currentUrl() });

        // Let client-side redirects (e.g. to a login page) settle before recording
        // where the browser really ended up.
        await sleep(3000);
        const finalUrl = session.page.currentUrl();
        const loginWall = /\/(login|signin|sign-in|auth)\b/i.test(new URL(finalUrl).pathname);
        if (finalUrl !== billingUrl) emit("PAGE_REDIRECTED", { url: finalUrl, loginWall });

        const title = (await session.page.textContent("title").catch(() => null))?.trim() || undefined;

        let screenshotPath: string | undefined;
        try {
          const png = await session.control.screenshot();
          await mkdir(opts.screenshotsDir, { recursive: true });
          screenshotPath = join(opts.screenshotsDir, `${jobId}.png`);
          await writeFile(screenshotPath, png);
          emit("SCREENSHOT_CAPTURED", { path: screenshotPath, bytes: png.byteLength });
        } catch (err) {
          emit("SCREENSHOT_FAILED", { error: err instanceof Error ? err.message : String(err) });
        }

        const holdMs = opts.holdMs ?? 120_000;
        if (holdMs > 0) {
          emit("STEEL_SESSION_HOLDING", { maxSeconds: Math.round(holdMs / 1000) });
          const ended = await Promise.race([hold.then(() => "user"), sleep(holdMs).then(() => "timeout")]);
          emit("STEEL_SESSION_HOLD_ENDED", { by: ended });
        }

        return { ...live, finalUrl, title, screenshotPath };
      } finally {
        await session.close();
        emit("SESSION_CLOSED", { sessionId: session.sessionId });
      }
    },
  };
}
