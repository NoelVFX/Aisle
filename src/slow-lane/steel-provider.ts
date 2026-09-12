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
  /** Navigation default timeout (ms). */
  navigationTimeoutMs?: number;

  // ---- First-class below-the-protocol Steel features -----------------------

  /** Route the session through Steel's residential proxy pool. */
  useProxy?: boolean;
  /** Bring-your-own proxy (overrides useProxy). http(s)://user:pass@host:port */
  proxyUrl?: string;
  /** Enable Steel's automatic CAPTCHA solving. */
  solveCaptcha?: boolean;
  /** Steel stealth / anti-fingerprint options (set before the socket exists). */
  stealth?: SessionCreateParams["stealthConfig"];
  /** Block ads/trackers in the session. */
  blockAds?: boolean;
  /** Region to start the browser in (latency / geo). */
  region?: SessionCreateParams["region"];
  /** Viewport dimensions. */
  dimensions?: SessionCreateParams["dimensions"];
  /**
   * Steel session timeout (ms). The default (5 min) will expire while a human
   * taps approve — set this generously. Defaults to 15 min here.
   */
  sessionTimeoutMs?: number;
  /**
   * Enable Steel CREDENTIAL INJECTION for the session. Steel types stored
   * secrets straight into the page, so the card/login never enters this process
   * or a model prompt. This flag carries NO secret — the value must be stored in
   * Steel out-of-band (dashboard or `client.credentials.create`), keyed to the
   * vendor origin. This agent never handles the plaintext secret itself.
   */
  credentials?: SessionCreateParams["credentials"];

  /** Escape hatch: raw sessions.create params, merged under the named options. */
  sessionOptions?: SessionCreateParams;
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
  async innerText(): Promise<string> {
    // Playwright API (not evaluate) — read-only, so isTrusted is irrelevant here.
    return this.page.locator("body").innerText();
  }
  async tryClickByText(text: string): Promise<boolean> {
    const loc = this.page.getByText(text, { exact: false }).first();
    if ((await loc.count()) === 0) return false;
    try {
      await loc.click({ timeout: 4000 });
      return true;
    } catch {
      return false;
    }
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

  async listReceiptFiles(): Promise<string[]> {
    // Files the vendor's confirmation page dropped into the session (receipts,
    // invoices, license keys) — Steel preserves them past release.
    const listed = await this.client.sessions.files.list(this.sessionId);
    return listed.data.map((f) => f.path);
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

    // Named options win over the raw escape hatch.
    const o = this.options;
    const body: SessionCreateParams = { ...o.sessionOptions };
    if (o.useProxy !== undefined) body.useProxy = o.useProxy;
    if (o.proxyUrl !== undefined) body.proxyUrl = o.proxyUrl;
    if (o.solveCaptcha !== undefined) body.solveCaptcha = o.solveCaptcha;
    if (o.stealth !== undefined) body.stealthConfig = o.stealth;
    if (o.blockAds !== undefined) body.blockAds = o.blockAds;
    if (o.region !== undefined) body.region = o.region;
    if (o.dimensions !== undefined) body.dimensions = o.dimensions;
    if (o.credentials !== undefined) body.credentials = o.credentials;
    // Keep the remote session alive through human approval (default 5 min is too short).
    body.timeout = o.sessionTimeoutMs ?? 15 * 60 * 1000;
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
