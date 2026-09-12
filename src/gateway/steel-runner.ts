/**
 * The gateway's Steel step: open a real Steel session on the LOCKED billing
 * origin, take a screenshot through `sessions.computer`, and release.
 *
 * It does not purchase. It never runs the checkout, never consumes the mandate,
 * and uses `persistProfile: false` so a test run never writes a stored identity.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SteelBrowserProvider, type SteelProviderOptions } from "../slow-lane/steel-provider.js";
import type { SteelEvidence, SteelRunner } from "./recovery.js";

export interface SteelRunnerOptions {
  /** Keep the session open this long so you can watch it in the viewer. */
  holdMs?: number;
  screenshotsDir: string;
  provider?: SteelProviderOptions;
}

export function createSteelRunner(opts: SteelRunnerOptions): SteelRunner {
  return {
    async run({ provider, billingOrigin, jobId, emit }): Promise<SteelEvidence> {
      const steel = new SteelBrowserProvider(opts.provider); // throws if STEEL_API_KEY is missing
      const session = await steel.createSession({ provider, persistProfile: false });
      emit("STEEL_SESSION_CREATED", { sessionId: session.sessionId, viewer: session.sessionViewerUrl });

      try {
        await session.page.goto(billingOrigin);
        const finalUrl = session.page.currentUrl();
        emit("PAGE_OPENED", { url: finalUrl });

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

        if (opts.holdMs && opts.holdMs > 0) await new Promise((r) => setTimeout(r, opts.holdMs));
        return { sessionId: session.sessionId, viewerUrl: session.sessionViewerUrl, finalUrl, title, screenshotPath };
      } finally {
        await session.close();
        emit("SESSION_CLOSED", { sessionId: session.sessionId });
      }
    },
  };
}
