/**
 * Steel Cloud browser provider.
 *
 * Creates a remote Steel session, connects Playwright to it over CDP, and
 * exposes the standard `BrowserSession` port (PageLike + ControlSurface +
 * profile save). Because Steel runs the browser remotely we depend on
 * `playwright-core` (no local browser download) and connect via
 * `chromium.connectOverCDP(session.connectUrl)`.
 *
 * NOTE: the Steel SDK surface is accessed loosely (typed `any`) so the provider
 * keeps working across SDK versions — confirm exact method/field names
 * (`sessions.create`, `connectUrl`/`websocketUrl`, `sessions.context`,
 * `sessions.release`) against the Steel docs for your installed version.
 */

import Steel from "steel-sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import type {
  BrowserProfile,
  BrowserProvider,
  BrowserSession,
  ControlSurface,
  CreateSessionOptions,
  PageLike,
} from "./browser.js";

export interface SteelProviderOptions {
  /** Defaults to process.env.STEEL_API_KEY. */
  apiKey?: string;
  /** Extra options forwarded to sessions.create (proxy, captcha solver, etc.). */
  sessionOptions?: Record<string, unknown>;
  /** Navigation default timeout (ms). */
  navigationTimeoutMs?: number;
}

class PlaywrightPage implements PageLike {
  constructor(
    private readonly page: Page,
    private readonly navTimeout: number,
  ) {}

  currentUrl(): string {
    return this.page.url();
  }
  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: this.navTimeout });
  }
  async clickByText(text: string): Promise<void> {
    await this.page.getByText(text, { exact: false }).first().click();
  }
  async clickBySelector(selector: string): Promise<void> {
    await this.page.click(selector);
  }
  async fill(selector: string, value: string): Promise<void> {
    await this.page.fill(selector, value);
  }
  async textContent(selector: string): Promise<string | null> {
    return this.page.textContent(selector);
  }
  async queryAllText(selector: string): Promise<string[]> {
    return this.page.$$eval(selector, (els) => els.map((e) => e.textContent ?? ""));
  }
  async waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
    await this.page.waitForSelector(selector, timeoutMs === undefined ? {} : { timeout: timeoutMs });
  }
}

class PlaywrightControl implements ControlSurface {
  constructor(private readonly page: Page) {}

  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot();
  }
  viewport(): { width: number; height: number } {
    return this.page.viewportSize() ?? { width: 1280, height: 800 };
  }
  async mouseClick(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
  }
  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }
  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }
  async scroll(dx: number, dy: number): Promise<void> {
    await this.page.mouse.wheel(dx, dy);
  }
  currentUrl(): string {
    return this.page.url();
  }
}

class SteelBrowserSession implements BrowserSession {
  constructor(
    readonly sessionId: string,
    readonly provider: string,
    readonly page: PageLike,
    readonly control: ControlSurface,
    private readonly browser: Browser,
    private readonly client: { sessions: Record<string, (...args: never[]) => unknown> },
    readonly sessionViewerUrl?: string,
  ) {}

  async saveProfile(): Promise<BrowserProfile> {
    // Steel exposes the live cookies/localStorage as the session "context".
    const ctxFn = this.client.sessions["context"] as
      | ((id: string) => Promise<unknown>)
      | undefined;
    const context = ctxFn ? await ctxFn(this.sessionId) : undefined;
    return { provider: this.provider, context, savedAt: new Date().toISOString() };
  }

  async close(): Promise<void> {
    try {
      await this.browser.close();
    } finally {
      const releaseFn = this.client.sessions["release"] as
        | ((id: string) => Promise<unknown>)
        | undefined;
      if (releaseFn) await releaseFn(this.sessionId);
    }
  }
}

export class SteelBrowserProvider implements BrowserProvider {
  private readonly apiKey: string;
  private readonly options: SteelProviderOptions;

  constructor(options: SteelProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env["STEEL_API_KEY"];
    if (!apiKey) {
      throw new Error("STEEL_API_KEY is required for SteelBrowserProvider.");
    }
    this.apiKey = apiKey;
    this.options = options;
  }

  async createSession(opts: CreateSessionOptions): Promise<BrowserSession> {
    // Typed loosely on purpose — see file header.
    const client: any = new (Steel as any)({ steelAPIKey: this.apiKey });

    const createArgs: Record<string, unknown> = { ...this.options.sessionOptions };
    if (opts.profile?.context !== undefined) {
      // Resume saved auth (cookies/localStorage) for this vendor.
      createArgs["sessionContext"] = opts.profile.context;
    }

    const session = await client.sessions.create(createArgs);
    const connectUrl: string = session.connectUrl ?? session.websocketUrl ?? session.wsUrl;
    const viewerUrl: string | undefined = session.sessionViewerUrl ?? session.debugUrl;

    const browser = await chromium.connectOverCDP(connectUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    const navTimeout = this.options.navigationTimeoutMs ?? 30_000;
    return new SteelBrowserSession(
      session.id,
      opts.provider,
      new PlaywrightPage(page, navTimeout),
      new PlaywrightControl(page),
      browser,
      client,
      viewerUrl,
    );
  }
}
