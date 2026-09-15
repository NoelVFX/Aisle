/**
 * Local Playwright browser provider — the Agentic Checkout slow-lane engine.
 *
 * Runs a real Chromium on this machine via `chromium.launchPersistentContext`,
 * so there is no cloud round-trip (far faster than a remote CDP browser). The
 * "profile" is simply the persistent userDataDir: whatever the user signs in to
 * once (see `login.ts`) is remembered there, and every later session restores it.
 *
 * Because the context is persistent, cookies/localStorage are written back to the
 * userDataDir automatically on `close()` — there is no separate upload step, so
 * `waitForProfileReady` is unnecessary.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { profileDirFor } from "./profiles.js";
import type {
  BrowserProvider,
  BrowserSession,
  ControlSurface,
  CreateSessionOptions,
  PageLike,
  ProfileMount,
} from "./browser.js";
import {
  ACTION_TIMEOUT_MS,
  DEFAULT_DIMENSIONS,
  NAVIGATION_TIMEOUT_MS,
  PlaywrightControl,
  PlaywrightPage,
} from "./playwright-page.js";

export interface LocalProviderOptions {
  /** Base directory under which new per-vendor userDataDirs are created. */
  profilesDir: string;
  /** Show the browser window (default true) so a human can watch and take over a login. */
  headed?: boolean;
  /** Playwright browser channel, e.g. "chrome" to use installed Chrome. Defaults to bundled Chromium. */
  channel?: string;
  actionTimeoutMs?: number;
  navigationTimeoutMs?: number;
  dimensions?: { width: number; height: number };
}

class LocalBrowserSession implements BrowserSession {
  constructor(
    readonly sessionId: string,
    readonly provider: string,
    readonly page: PageLike,
    readonly control: ControlSurface,
    readonly profile: ProfileMount | undefined,
    private readonly context: BrowserContext,
  ) {}

  async close(): Promise<void> {
    // Persistent context flushes the userDataDir (cookies, localStorage) on close.
    await this.context.close();
  }
}

export class LocalBrowserProvider implements BrowserProvider {
  constructor(private readonly options: LocalProviderOptions) {
    mkdirSync(options.profilesDir, { recursive: true });
  }

  async createSession(opts: CreateSessionOptions): Promise<BrowserSession> {
    if (opts.sessionContext !== undefined) {
      throw new Error("LocalBrowserProvider does not support sessionContext capture; use a persistent profile.");
    }
    const o = this.options;
    const dims = o.dimensions ?? DEFAULT_DIMENSIONS;
    // The profileId IS the userDataDir. Restore the bound one, or use the stable
    // per-vendor dir so a login done once (login.ts) is reused by every path.
    const userDataDir = opts.profile?.profileId ?? profileDirFor(o.profilesDir, opts.provider);
    mkdirSync(userDataDir, { recursive: true });

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: o.headed === false,
      viewport: dims,
      ...(o.channel ? { channel: o.channel } : {}),
      // A normal window UA; headed Chromium already presents as Chrome, which clears
      // most "unsupported browser" walls without a cloud stealth layer.
      args: ["--disable-blink-features=AutomationControlled"],
    });
    let page: Page;
    try {
      page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(o.actionTimeoutMs ?? ACTION_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(o.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS);
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }

    const sessionId = `local_${Date.now()}_${randomUUID().slice(0, 8)}`;
    return new LocalBrowserSession(
      sessionId,
      opts.provider,
      new PlaywrightPage(page),
      new PlaywrightControl(page, dims),
      { profileId: userDataDir },
      context,
    );
  }
}
