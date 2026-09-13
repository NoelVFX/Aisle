/**
 * Steel Cloud browser provider (steel.md §3–§6, §9, §20).
 *
 * Creates a purchase-worker session on a Steel profile, connects Playwright over
 * CDP, and exposes the `BrowserSession` port. Typed against steel-sdk v0.18:
 * `new Steel({ steelAPIKey })`, `sessions.create()` → `Session` (CDP at
 * `.websocketUrl`, live view at `.sessionViewerUrl`, effective `.timeout`,
 * mounted `.profileId`), `sessions.computer(id, action)`,
 * `sessions.files.list(id)`, `sessions.release(id)`, `profiles.get(id)`.
 *
 * Remembering (steel.md §6) uses the Profiles API. With no stored binding,
 * `persistProfile: true` makes Steel create a profile and return its id; later
 * sessions restore it with `profileId`. Steel writes the userDataDir on release
 * (UPLOADING → READY), so `waitForProfileReady` gates the next run. The profile
 * is pinned to a dedicated IP (`useProxy: { type: "fixed", id }`) so restored
 * cookies never arrive from a new egress.
 *
 * Supported by the SDK but not wired yet (⚠ VERIFY before relying on them):
 *   - `extensionIds` attach and `debugConfig.interactive` for the viewer.
 * The SDK has no Agent Traces export.
 */

import Steel from "steel-sdk";
import type { ProfileGetResponse } from "steel-sdk/resources/profiles.js";
import type { Session, SessionCreateParams } from "steel-sdk/resources/sessions/sessions.js";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import type {
  ActionCandidate,
  BrowserProvider,
  BrowserSession,
  ControlSurface,
  CreateSessionOptions,
  PageLike,
  ProfileMount,
  ProfileReadiness,
} from "./browser.js";
import { SteelComputerControl, SteelCursor } from "./steel-computer.js";

/** steel.md §11 — captcha solves take tens of seconds inside a payment flow. */
export const CHECKOUT_TIMEOUT_MS = 90_000;
/** steel.md §3 — 15 minutes. `timeout` cannot be raised on a live session. */
export const PURCHASE_SESSION_TIMEOUT_MS = 15 * 60_000;
/** steel.md §22 — READY latency is unmeasured; allow a minute until it is. */
export const PROFILE_READY_TIMEOUT_MS = 60_000;

const PROFILE_READY_POLL_MS = 1_000;
const DEFAULT_DIMENSIONS = { width: 1280, height: 720 };

/**
 * Stealth identity for the purchase/login browser. Vendors increasingly reject a
 * bare automation fingerprint with an "unsupported browser" wall — which also
 * hides the signed-in UI, so it reads as a surprise logout. A humanized,
 * fingerprint-injected session passes those checks.
 *
 * MUST be identical between the interactive login session and every later
 * purchase session on the same profile: a fingerprint that shifts under existing
 * cookies trips the vendor's security re-check and really does log you out. So
 * both call this. Disable with AISLE_STEEL_STEALTH=0.
 */
export function stealthFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SessionCreateParams["stealthConfig"] | undefined {
  if (env["AISLE_STEEL_STEALTH"] === "0") return undefined;
  return { humanizeInteractions: true, skipFingerprintInjection: false };
}

export interface SteelProviderOptions {
  /** Defaults to process.env.STEEL_API_KEY. */
  apiKey?: string;
  /** Default Playwright timeout for navigation and actions. Defaults to 90s. */
  navigationTimeoutMs?: number;

  // ---- Purchase-worker configuration (steel.md §4.1). Defaults follow the doc.
  /** Residential proxy. Default true. Ignored when the profile is pinned to a dedicated IP. */
  useProxy?: boolean;
  /**
   * Custom proxy URL (overrides useProxy). Refused when a dedicated IP is pinned,
   * because it would move a restored identity to a new egress.
   */
  proxyUrl?: string;
  /**
   * Steel dedicated IP (`fixed:…`, dashboard Settings → Network) that pins
   * profiles with no IP yet. Defaults to STEEL_DEDICATED_IP_ID. A restored
   * profile always keeps the IP it was pinned with (steel.md §6, §9).
   */
  dedicatedIpId?: string;
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
  /** How long `waitForProfileReady` polls before reporting TIMEOUT. Default 60s. */
  profileReadyTimeoutMs?: number;
  /** Poll interval for `waitForProfileReady`. Default 1s. */
  profileReadyPollMs?: number;

  /**
   * What the computer-use resolver drives.
   *   "steel-computer" (default): Steel's `sessions.computer` API takes screenshots
   *     and executes actions, matching Steel's Computer Use integration.
   *   "playwright": Playwright mouse/keyboard over CDP.
   */
  controlSurface?: "steel-computer" | "playwright";

  /**
   * Route deterministic clicks through Steel's `sessions.computer` so the real
   * OS cursor visibly glides and clicks in the live viewer. Default true. Falls
   * back to a Playwright click if the element has no box or the API fails.
   */
  visibleCursor?: boolean;

  /**
   * Escape hatch: raw sessions.create params, merged under the named options.
   * Never set `inactivityTimeout` (kills a session parked for approval) or
   * `optimizeBandwidth` (breaks 3-DS iframes) on a purchase worker. Profile
   * selection (`profileId`, `persistProfile`, `sessionContext`) is refused here:
   * it comes from the ProfileStore binding.
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

/**
 * steel.md §6: a session that silently lost its profile remembers nothing.
 * Returns the mounted profileId. Errors never include the id (credential-tier).
 */
export function assertProfileMounted(
  session: Pick<Session, "profileId">,
  params: Pick<SessionCreateParams, "profileId" | "persistProfile">,
): string | undefined {
  if (params.profileId !== undefined && session.profileId !== params.profileId) {
    throw new Error("STEEL_PROFILE_NOT_MOUNTED: asked to restore a profile; the session reports a different or no profileId.");
  }
  if (params.persistProfile && !session.profileId) {
    throw new Error("STEEL_PROFILE_NOT_CREATED: persistProfile was set but the session returned no profileId; nothing would be remembered.");
  }
  return session.profileId;
}

/** What `createSession` sends to Steel, plus the values it asserts against. */
export interface SessionPlan {
  params: SessionCreateParams;
  timeoutMs: number;
  dimensions: { width: number; height: number };
  /** Dedicated IP the session is pinned to, if any. */
  dedicatedIpId: string | undefined;
}

/**
 * Build the purchase-worker `sessions.create` body (steel.md §4.1, §6, §9).
 * Pure, so the identity rules are testable without a Steel account.
 */
export function buildSessionCreateParams(
  o: SteelProviderOptions,
  opts: CreateSessionOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SessionPlan {
  for (const owned of ["profileId", "persistProfile", "sessionContext"] as const) {
    if (o.sessionOptions?.[owned] !== undefined) {
      throw new Error(`'${owned}' must not be set via sessionOptions: the profile comes from the ProfileStore binding (steel.md §6).`);
    }
  }

  const envTimeout = Number(env["STEEL_SESSION_TIMEOUT_MS"]);
  const timeoutMs = o.sessionTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : PURCHASE_SESSION_TIMEOUT_MS);
  const dimensions = o.dimensions ?? o.sessionOptions?.dimensions ?? DEFAULT_DIMENSIONS;

  const params: SessionCreateParams = {
    ...o.sessionOptions,
    useProxy: o.useProxy ?? o.sessionOptions?.useProxy ?? true,
    solveCaptcha: o.solveCaptcha ?? o.sessionOptions?.solveCaptcha ?? true,
    blockAds: o.blockAds ?? o.sessionOptions?.blockAds ?? true,
    dimensions,
    timeout: timeoutMs,
    // Browser identity: restore the bound profile, or let Steel create one.
    persistProfile: opts.persistProfile ?? true,
  };
  if (opts.sessionContext !== undefined) {
    if (opts.profile) throw new Error("A session starts from a profile or from a captured session context, not both.");
    params.sessionContext = opts.sessionContext as SessionCreateParams["sessionContext"];
    params.persistProfile = false;
  }
  if (opts.profile) params.profileId = opts.profile.profileId;
  if (o.stealth !== undefined) params.stealthConfig = o.stealth;
  if (o.region !== undefined) params.region = o.region;
  if (o.credentials !== undefined) params.credentials = o.credentials;

  // Network identity: a profile keeps the dedicated IP it was pinned with; the
  // configured IP only pins profiles that have none yet.
  const dedicatedIpId = opts.profile?.dedicatedIpId ?? o.dedicatedIpId ?? (env["STEEL_DEDICATED_IP_ID"] || undefined);
  const proxyUrl = o.proxyUrl ?? o.sessionOptions?.proxyUrl;
  if (dedicatedIpId !== undefined) {
    if (proxyUrl !== undefined) {
      throw new Error("PROFILE_IP_PIN_CONFLICT: proxyUrl would override the dedicated IP pinned to this profile (steel.md §6, §9). Remove one.");
    }
    params.useProxy = { type: "fixed", id: dedicatedIpId };
  } else if (proxyUrl !== undefined) {
    params.proxyUrl = proxyUrl;
  }

  for (const forbidden of ["inactivityTimeout", "optimizeBandwidth"]) {
    if (forbidden in (params as Record<string, unknown>)) {
      throw new Error(`'${forbidden}' must not be set on a purchase-worker session (steel.md §3, §4.1).`);
    }
  }
  return { params, timeoutMs, dimensions, dedicatedIpId };
}

/** The slice of the Steel client profile polling needs. Structural, so tests can fake it. */
export interface SteelProfilesClient {
  profiles: {
    get(id: string): PromiseLike<Pick<ProfileGetResponse, "status">>;
  };
}

export interface ProfileReadyOptions {
  timeoutMs?: number | undefined;
  pollMs?: number | undefined;
  /** Injectable for tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
}

/**
 * steel.md §6: poll a released profile until Steel has persisted it. A session
 * created on the profile before READY restores stale state.
 */
export async function waitForProfileReady(
  client: SteelProfilesClient,
  profileId: string,
  options: ProfileReadyOptions = {},
): Promise<ProfileReadiness> {
  const pollMs = options.pollMs ?? PROFILE_READY_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? PROFILE_READY_TIMEOUT_MS);
  for (;;) {
    const { status } = await client.profiles.get(profileId);
    if (status === "READY" || status === "FAILED") return status;
    if (now() >= deadline) return "TIMEOUT";
    await sleep(pollMs);
  }
}

const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "radio",
  "checkbox",
  "combobox",
  "menuitem",
  "tab",
  "textbox",
  "spinbutton",
  "searchbox",
  "option",
  "switch",
]);
const MAX_CANDIDATES = 80;

type AxNode = { ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; backendDOMNodeId?: number };
type RoleArg = Parameters<Page["getByRole"]>[0];

class PlaywrightPage implements PageLike {
  private cdp: CDPSession | undefined;

  constructor(
    private readonly page: Page,
    private readonly cursor?: SteelCursor,
  ) {}

  /** Click a viewport point with the visible cursor, else through Playwright. */
  private async pointClick(x: number, y: number): Promise<void> {
    if (this.cursor) {
      try {
        await this.cursor.click(x, y);
        return;
      } catch {
        // fall through to an invisible but reliable CDP click
      }
    }
    await this.page.mouse.click(x, y);
  }

  private async clickLocator(loc: ReturnType<Page["locator"]>): Promise<void> {
    if (this.cursor) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const box = await loc.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        return this.pointClick(box.x + box.width / 2, box.y + box.height / 2);
      }
    }
    await loc.click();
  }

  private async cdpSession(): Promise<CDPSession> {
    if (!this.cdp) {
      this.cdp = await this.page.context().newCDPSession(this.page);
      await this.cdp.send("DOM.enable").catch(() => {});
      await this.cdp.send("Accessibility.enable").catch(() => {});
    }
    return this.cdp;
  }

  async jsonLd(): Promise<unknown[]> {
    return this.page.$$eval('script[type="application/ld+json"]', (els) =>
      els
        .map((e) => {
          try {
            return JSON.parse(e.textContent ?? "") as unknown;
          } catch {
            return null;
          }
        })
        .filter((x) => x !== null),
    );
  }

  /** Tier 3 (§17): real nodes from Accessibility.getFullAXTree, numbered. */
  async actionableCandidates(): Promise<ActionCandidate[]> {
    const cdp = await this.cdpSession();
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as unknown as { nodes: AxNode[] };
    const out: ActionCandidate[] = [];
    for (const n of nodes) {
      const role = String(n.role?.value ?? "");
      const name = String(n.name?.value ?? "").replace(/\s+/g, " ").trim();
      if (n.ignored || !ACTIONABLE_ROLES.has(role) || !name || n.backendDOMNodeId === undefined) continue;
      const near = await this.nearPriceText(cdp, n.backendDOMNodeId).catch(() => "");
      out.push({ index: out.length, role, name: name.slice(0, 120), near, backendNodeId: n.backendDOMNodeId });
      if (out.length >= MAX_CANDIDATES) break;
    }
    return out;
  }

  /** Walk up to three ancestors and return the first price-bearing text. */
  private async nearPriceText(cdp: CDPSession, backendNodeId: number): Promise<string> {
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId });
    if (!object.objectId) return "";
    try {
      const res = await cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration:
          "function(){let el=this;for(let i=0;i<4&&el;i++){const t=(el.innerText||'').replace(/\\s+/g,' ').trim();" +
          "if(/[$€£]\\s?\\d/.test(t))return t.slice(0,160);el=el.parentElement;}return '';}",
      });
      return typeof res.result.value === "string" ? res.result.value : "";
    } finally {
      await cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    }
  }

  private async centerOf(candidate: ActionCandidate): Promise<{ x: number; y: number }> {
    if (candidate.backendNodeId === undefined) throw new Error("Candidate has no DOM node.");
    const cdp = await this.cdpSession();
    await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: candidate.backendNodeId }).catch(() => {});
    const { quads } = await cdp.send("DOM.getContentQuads", { backendNodeId: candidate.backendNodeId });
    const q = quads[0];
    if (!q || q.length < 8) throw new Error(`Candidate "${candidate.name}" is not visible.`);
    return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
  }

  async clickCandidate(candidate: ActionCandidate): Promise<void> {
    const { x, y } = await this.centerOf(candidate);
    await this.pointClick(x, y);
  }

  async fillCandidate(candidate: ActionCandidate, value: string): Promise<void> {
    const { x, y } = await this.centerOf(candidate);
    await this.pointClick(x, y);
    await this.page.keyboard.press("Control+A"); // Steel browsers run on Linux
    await this.page.keyboard.type(value);
  }

  async clickByRole(role: string, name: string | RegExp): Promise<boolean> {
    const loc = this.page.getByRole(role as RoleArg, { name, exact: typeof name === "string" }).first();
    if ((await loc.count()) === 0) return false;
    await this.clickLocator(loc);
    return true;
  }

  async fillByRole(role: string, name: string | RegExp, value: string): Promise<boolean> {
    const loc = this.page.getByRole(role as RoleArg, { name, exact: typeof name === "string" }).first();
    if ((await loc.count()) === 0) return false;
    await loc.fill(value);
    return true;
  }

  async setChecked(selector: string, checked: boolean): Promise<boolean> {
    const loc = this.page.locator(selector).first();
    if ((await loc.count()) === 0) return false;
    if ((await loc.isChecked().catch(() => checked)) === checked) return false;
    await loc.setChecked(checked, { force: true });
    return true;
  }

  async settle(ms = 1500): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForTimeout(ms);
  }

  currentUrl(): string {
    return this.page.url();
  }
  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }
  async clickByText(text: string): Promise<void> {
    await this.clickLocator(this.page.getByText(text, { exact: false }).first());
  }
  async clickBySelector(selector: string, timeoutMs?: number): Promise<void> {
    // `.first()` so union/proximity selectors (e.g. "a, button" or ":near(...)")
    // don't trip Playwright strict mode; the nearest/first match is the target.
    await this.page.locator(selector).first().click(timeoutMs === undefined ? {} : { timeout: timeoutMs });
  }
  async dismissOverlays(closeSelectors: string[] = []): Promise<void> {
    // Many modals close on Escape; try it first (cheap, never blocks a read).
    await this.page.keyboard.press("Escape").catch(() => {});
    for (const selector of closeSelectors) {
      const loc = this.page.locator(selector).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      // Bounded: a present-but-obscured close control must not stall the 90s default.
      await loc.click({ timeout: 2000 }).catch(() => {});
    }
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
    await this.clickLocator(loc);
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
    readonly profile: ProfileMount | undefined,
    private readonly browser: Browser,
    private readonly client: Steel,
  ) {}

  async listReceiptFiles(): Promise<string[]> {
    const listed = await this.client.sessions.files.list(this.sessionId);
    return listed.data.map((f) => f.path);
  }

  async close(): Promise<void> {
    try {
      await this.browser.close();
    } finally {
      // REQUIRED: release ends billing and starts the profile write (UPLOADING → READY).
      await this.client.sessions.release(this.sessionId);
    }
  }
}

export class SteelBrowserProvider implements BrowserProvider {
  private readonly client: Steel;
  private readonly options: SteelProviderOptions;

  constructor(options: SteelProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env["STEEL_API_KEY"];
    if (!apiKey) throw new Error("STEEL_API_KEY is required for SteelBrowserProvider.");
    this.client = new Steel({ steelAPIKey: apiKey });
    this.options = options;
  }

  async createSession(opts: CreateSessionOptions): Promise<BrowserSession> {
    const client = this.client;
    const o = this.options;
    const plan = buildSessionCreateParams(o, opts);

    const session: Session = await client.sessions.create(plan.params);

    let browser: Browser | undefined;
    try {
      assertTimeoutApplied(session, plan.timeoutMs);
      const profileId = assertProfileMounted(session, plan.params);
      browser = await chromium.connectOverCDP(session.websocketUrl);
      // Steel hands you a context and page already open. A new context would NOT
      // inherit the mounted profile, so never create one.
      const context = browser.contexts()[0];
      const page = context?.pages()[0];
      if (!context || !page) {
        throw new Error("Steel session exposed no default context/page; refusing to create one (steel.md §5).");
      }
      page.setDefaultTimeout(o.navigationTimeoutMs ?? CHECKOUT_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(o.navigationTimeoutMs ?? CHECKOUT_TIMEOUT_MS);

      const control: ControlSurface =
        (o.controlSurface ?? "steel-computer") === "steel-computer"
          ? new SteelComputerControl(client, session.id, plan.dimensions, () => page.url())
          : new PlaywrightControl(page, plan.dimensions);

      const profile: ProfileMount | undefined =
        profileId === undefined
          ? undefined
          : plan.dedicatedIpId === undefined
            ? { profileId }
            : { profileId, dedicatedIpId: plan.dedicatedIpId };

      return new SteelBrowserSession(
        session.id,
        opts.provider,
        new PlaywrightPage(
          page,
          o.visibleCursor === false
            ? undefined
            : new SteelCursor(client, session.id, page, process.env["AISLE_DEBUG_CURSOR"] === "1" ? { debug: (m) => console.error(`[steel] ${m}`) } : {}),
        ),
        control,
        session.sessionViewerUrl,
        profile,
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

  waitForProfileReady(profileId: string): Promise<ProfileReadiness> {
    return waitForProfileReady(this.client, profileId, {
      timeoutMs: this.options.profileReadyTimeoutMs,
      pollMs: this.options.profileReadyPollMs,
    });
  }
}
