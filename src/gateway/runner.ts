/**
 * The gateway's preview step: open a local Chromium on the vendor's billing page
 * (the LOCKED billing origin), screenshot it for the approval card, hold briefly
 * so the user can watch, then close.
 *
 * It does not purchase. It never runs the checkout, never consumes the mandate,
 * and uses a throwaway profile so a preview never writes a stored identity.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalBrowserProvider, type LocalProviderOptions } from "../slow-lane/local-provider.js";
import type { SteelEvidence, SteelRunner } from "./recovery.js";

export interface LocalRunnerOptions {
  /** Longest the window stays open for watching, unless ended from the approval page. */
  holdMs?: number;
  screenshotsDir: string;
  /** Throwaway userDataDir base for previews (never bound to a user/vendor). */
  previewProfilesDir: string;
  browser?: Partial<LocalProviderOptions>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createLocalRunner(opts: LocalRunnerOptions): SteelRunner {
  return {
    async run({ provider, billingUrl, jobId, emit, onLive, hold }): Promise<SteelEvidence> {
      const browser = new LocalBrowserProvider({ profilesDir: opts.previewProfilesDir, headed: false, ...opts.browser });
      const session = await browser.createSession({ provider, persistProfile: false });

      try {
        const live = { sessionId: session.sessionId, debugUrl: undefined, viewerUrl: undefined };
        emit("STEEL_SESSION_CREATED", { ...live });
        onLive(live);

        await session.page.goto(billingUrl);
        emit("PAGE_OPENED", { requested: billingUrl, url: session.page.currentUrl() });

        // Let client-side redirects (e.g. to a login page) settle before recording where it landed.
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
