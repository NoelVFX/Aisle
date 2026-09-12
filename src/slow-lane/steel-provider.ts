/**
 * Steel Cloud browser provider.
 *
 * Creates a remote Steel session, connects Playwright to it over CDP
 * (`chromium.connectOverCDP(session.websocketUrl)`), and exposes the standard
 * `BrowserSession` port (PageLike + ControlSurface + profile save). Because
 * Steel runs the browser remotely we depend on `playwright-core` — no local
 * browser download.
 *
 * Typed against steel-sdk v0.8: `new Steel({ steelAPIKey })`,
 * `sessions.create({ sessionContext })` → `Session` (CDP at `.websocketUrl`,
 * live view at `.sessionViewerUrl`), `sessions.context(id)`, `sessions.release(id)`.
 */

import Steel from "steel-sdk";
import type {
  Session,
  SessionContext,
  SessionCreateParams,
} from "steel-sdk/resources/sessions/sessions.js";
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
  /** Extra options forwarded to sessions.create (proxy, captcha, dimensions, …). */
  sessionOptions?: SessionCreateParams;
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
    readonly sessionViewerUrl: string,
    private readonly browser: Browser,
    private readonly client: Steel,
  ) {}

  async saveProfile(): Promise<BrowserProfile> {
    // Steel exposes the live cookies/localStorage as the session "context".
    const context: SessionContext = await this.client.sessions.context(this.sessionId);
    return { provider: this.provider, context, savedAt: new Date().toISOString() };
  }

  async close(): Promise<void> {
    try {
      await this.browser.close();
    } finally {
      await this.client.sessions.release(this.sessionId);
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
    const client = new Steel({ steelAPIKey: this.apiKey });

    const body: SessionCreateParams = { ...this.options.sessionOptions };
    if (opts.profile?.context !== undefined) {
      // Resume saved auth (cookies/localStorage) for this vendor.
      body.sessionContext = opts.profile.context as SessionCreateParams["sessionContext"];
    }

    const session: Session = await client.sessions.create(body);

    const browser = await chromium.connectOverCDP(session.websocketUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());

    const navTimeout = this.options.navigationTimeoutMs ?? 30_000;
    return new SteelBrowserSession(
      session.id,
      opts.provider,
      new PlaywrightPage(page, navTimeout),
      new PlaywrightControl(page),
      session.sessionViewerUrl,
      browser,
      client,
    );
  }
}
