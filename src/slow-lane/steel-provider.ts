/**
 * Steel Cloud browser provider (steel.md §3–§5, §20).
 *
 * Creates a purchase-worker session, connects Playwright over CDP, and exposes
 * the `BrowserSession` port. Typed against steel-sdk v0.8:
 * `new Steel({ steelAPIKey })`, `sessions.create()` → `Session` (CDP at
 * `.websocketUrl`, live view at `.sessionViewerUrl`, effective `.timeout`),
 * `sessions.context(id)`, `sessions.files.list(id)`, `sessions.release(id)`.
 *
 * SDK gaps vs the docs (⚠ VERIFY when upgrading steel-sdk):
 *   - No Profiles API (`profileId` / `persistProfile` / READY polling) in v0.8,
 *     so "remembering" uses the auth-context path (`sessions.context` →
 *     `sessionContext`, steel.md §7).
 *   - No Agent Traces export and no Extensions attach in v0.8.
 */

import Steel from "steel-sdk";
import type { Session, SessionContext, SessionCreateParams } from "steel-sdk/resources/sessions/sessions.js";
import { chromium, type Browser, type Page } from "playwright-core";
import type {
  BrowserProfile,
  BrowserProvider,
  BrowserSession,
  ControlSurface,
  CreateSessionOptions,
  PageLike,
} from "./browser.js";

/** steel.md §11 — captcha solves take tens of seconds inside a payment flow. */
export const CHECKOUT_TIMEOUT_MS = 90_000;
/** steel.md §3 — 15 minutes. `timeout` cannot be raised on a live session. */
export const PURCHASE_SESSION_TIMEOUT_MS = 15 * 60_000;

const DEFAULT_DIMENSIONS = { width: 1280, height: 720 };

export interface SteelProviderOptions {
  /** Defaults to process.env.STEEL_API_KEY. */
  apiKey?: string;
  /** Default Playwright timeout for navigation and actions. Defaults to 90s. */
  navigationTimeoutMs?: number;

  // ---- Purchase-worker configuration (steel.md §4.1). Defaults follow the doc.
  /** Residential proxy. Default true. */
  useProxy?: boolean;
  /** Dedicated IP pinned to the profile (overrides useProxy). */
  proxyUrl?: string;
  /** Captcha sidecar. Default true. */
  solveCaptcha?: boolean;
  /** Stealth config. Don't rotate the fingerprint between runs on one profile. */
  stealth?: SessionCreateParams["stealthConfig"];
  /** Default true. */
  blockAds?: boolean;
  /** Match the account's billing region (§17). */
  region?: SessionCreateParams["region"];
  /** Default 1280×720. */
  dimensions?: SessionCreateParams["dimensions"];
  /**
   * Hard session lifetime (ms). Defaults to STEEL_SESSION_TIMEOUT_MS or 15 min.
   * Asserted against the created session: an ignored key silently gives you 5 min.
   */
  sessionTimeoutMs?: number;
  /**
   * Steel credential injection: Steel types stored secrets into the page so the
   * card/login never enters this process or a model prompt. Carries no secret.
   * ⚠ VERIFY whether the vault holds card fields (steel.md §8) before claiming it.
   */
  credentials?: SessionCreateParams["credentials"];

  /**
   * Escape hatch: raw sessions.create params, merged under the named options.
   * Never set `inactivityTimeout` (kills a session parked for approval) or
   * `optimizeBandwidth` (breaks 3-DS iframes) on a purchase worker.
   */
  sessionOptions?: SessionCreateParams;
}

/** steel.md §3: assert the timeout was honoured. Throws if the session reports less. */
export function assertTimeoutApplied(session: Pick<Session, "timeout">, wantedMs: number): void {
  const actual = session.timeout;
  if (typeof actual !== "number" || actual < wantedMs * 0.9) {
    throw new Error(
      `STEEL_TIMEOUT_PARAM_WRONG: asked for ${wantedMs}ms, session reports ${String(actual)}. ` +
        "Fix the parameter name before doing anything else.",
    );
  }
}

class PlaywrightPage implements PageLike {
  constructor(private readonly page: Page) {}

  currentUrl(): string {
    return this.page.url();
  }
  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
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
    return this.page.locator("body").innerText();
  }
  async tryClickByText(text: string): Promise<boolean> {
    const loc = this.page.getByText(text, { exact: false }).first();
    if ((await loc.count()) === 0) return false;
    // The element exists; use the page default (90s) so a mid-click captcha
    // solve doesn't fail the step and tempt a retry into a half-submitted checkout.
    await loc.click();
    return true;
  }
}

class PlaywrightControl implements ControlSurface {
  constructor(
    private readonly page: Page,
    private readonly fallbackViewport: { width: number; height: number },
  ) {}

  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot();
  }
  viewport(): { width: number; height: number } {
    return this.page.viewportSize() ?? this.fallbackViewport;
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
    // Auth context: cookies + localStorage, captured live. Treat as a credential.
    const context: SessionContext = await this.client.sessions.context(this.sessionId);
    return { provider: this.provider, context, savedAt: new Date().toISOString() };
  }

  async listReceiptFiles(): Promise<string[]> {
    const listed = await this.client.sessions.files.list(this.sessionId);
    return listed.data.map((f) => f.path);
  }

  async close(): Promise<void> {
    try {
      await this.browser.close();
    } finally {
      // REQUIRED: release ends billing and triggers persistence.
      await this.client.sessions.release(this.sessionId);
    }
  }
}

export class SteelBrowserProvider implements BrowserProvider {
  private readonly apiKey: string;
  private readonly options: SteelProviderOptions;

  constructor(options: SteelProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env["STEEL_API_KEY"];
    if (!apiKey) throw new Error("STEEL_API_KEY is required for SteelBrowserProvider.");
    this.apiKey = apiKey;
    this.options = options;
  }

  async createSession(opts: CreateSessionOptions): Promise<BrowserSession> {
    const client = new Steel({ steelAPIKey: this.apiKey });
    const o = this.options;

    const envTimeout = Number(process.env["STEEL_SESSION_TIMEOUT_MS"]);
    const timeout = o.sessionTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : PURCHASE_SESSION_TIMEOUT_MS);
    const dimensions = o.dimensions ?? o.sessionOptions?.dimensions ?? DEFAULT_DIMENSIONS;

    const body: SessionCreateParams = {
      ...o.sessionOptions,
      useProxy: o.useProxy ?? o.sessionOptions?.useProxy ?? true,
      solveCaptcha: o.solveCaptcha ?? o.sessionOptions?.solveCaptcha ?? true,
      blockAds: o.blockAds ?? o.sessionOptions?.blockAds ?? true,
      dimensions,
      timeout,
    };
    if (o.proxyUrl !== undefined) body.proxyUrl = o.proxyUrl;
    if (o.stealth !== undefined) body.stealthConfig = o.stealth;
    if (o.region !== undefined) body.region = o.region;
    if (o.credentials !== undefined) body.credentials = o.credentials;
    if (opts.profile?.context !== undefined) {
      body.sessionContext = opts.profile.context as SessionCreateParams["sessionContext"];
    }
    for (const forbidden of ["inactivityTimeout", "optimizeBandwidth"]) {
      if (forbidden in (body as Record<string, unknown>)) {
        throw new Error(`'${forbidden}' must not be set on a purchase-worker session (steel.md §3, §4.1).`);
      }
    }

    const session: Session = await client.sessions.create(body);

    let browser: Browser | undefined;
    try {
      assertTimeoutApplied(session, timeout);
      browser = await chromium.connectOverCDP(session.websocketUrl);
      // Steel hands you a context and page already open. A new context would NOT
      // inherit the restored identity, so never create one.
      const context = browser.contexts()[0];
      const page = context?.pages()[0];
      if (!context || !page) {
        throw new Error("Steel session exposed no default context/page; refusing to create one (steel.md §5).");
      }
      page.setDefaultTimeout(o.navigationTimeoutMs ?? CHECKOUT_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(o.navigationTimeoutMs ?? CHECKOUT_TIMEOUT_MS);

      return new SteelBrowserSession(
        session.id,
        opts.provider,
        new PlaywrightPage(page),
        new PlaywrightControl(page, dimensions),
        session.sessionViewerUrl,
        browser,
        client,
      );
    } catch (err) {
      // Never leak a live, billed session (possibly with injected credentials).
      await browser?.close().catch(() => {});
      await client.sessions.release(session.id).catch(() => {});
      throw err;
    }
  }
}
