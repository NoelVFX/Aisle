/**
 * Link-based, one-time vendor sign-in — the friendly alternative to `npm run login`
 * and to any manual "/browser connect" step.
 *
 * When Aisle needs a vendor the user hasn't signed in to, it hands back a link
 * (served by the approval server). Opening it launches a real sign-in window in
 * that vendor's PERSISTENT profile. The user just logs in — Aisle WATCHES the
 * window, detects the signed-in state on its own, records the (user, vendor)
 * binding, and flips the window to a "You're logged in — close and return"
 * screen. No "I'm done" button, no second browser. Every later top-up/action
 * reuses the profile, like a connected MCP.
 *
 * The password is never seen by Aisle: it is typed into the vendor's own page.
 */

import { LocalBrowserProvider } from "../slow-lane/local-provider.js";
import { FileProfileStore } from "../slow-lane/profiles.js";
import type { BrowserSession, PageLike } from "../slow-lane/browser.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Longest we watch a sign-in window for completion before leaving it to the manual fallback. */
const LOGIN_WATCH_MS = 8 * 60_000;

/** How Aisle recognises "the user is signed in now" for a vendor. */
export interface LoginMarkers {
  loginUrl: string;
  /** Any non-empty match means signed in (e.g. "#logout-button"). */
  loggedInSelector?: string;
  /** A match means STILL signed out (e.g. a visible login form). Absent ⇒ signed in. */
  loggedOutSelector?: string;
  /** Pathname regex of the login wall; leaving it ⇒ signed in. */
  loginWallPattern?: string;
}

export interface LoginManagerDeps {
  profilesDir: string;
  store: FileProfileStore;
  userId: string;
  log: (message: string) => void;
}

export interface LoginView {
  provider: string;
  active: boolean;
  loggedIn: boolean;
  loginUrl?: string;
}

export class LoginManager {
  private readonly open = new Map<string, BrowserSession>();
  private readonly markers = new Map<string, LoginMarkers>();
  private readonly done = new Set<string>();

  constructor(private readonly deps: LoginManagerDeps) {}

  /** Record where and how to sign in for a vendor (set when LOGIN_REQUIRED is returned). */
  register(provider: string, markers: LoginMarkers): void {
    this.markers.set(provider, markers);
    this.done.delete(provider);
  }

  async isLoggedIn(provider: string): Promise<boolean> {
    // A SAVED binding is the only reliable signal — it's written only after a
    // completed sign-in (auto-detected, manual finish, or `npm run login`). A bare
    // userDataDir can exist from a half-started login and must NOT count.
    if (this.done.has(provider)) return true;
    return (await this.deps.store.load(this.deps.userId, provider)) !== undefined;
  }

  /** Open a headed sign-in window and start watching it for a successful login. */
  async start(provider: string, loginUrl?: string): Promise<LoginView> {
    if (this.open.has(provider)) return this.status(provider);
    const m = this.markers.get(provider) ?? (loginUrl ? { loginUrl } : undefined);
    if (!m?.loginUrl) throw new Error("NO_LOGIN_URL: unknown where to sign in for this vendor.");
    this.markers.set(provider, m);
    const browser = new LocalBrowserProvider({ profilesDir: this.deps.profilesDir, headed: true });
    const session = await browser.createSession({ provider });
    this.open.set(provider, session);
    this.done.delete(provider);
    await session.page.goto(m.loginUrl).catch(() => {});
    this.deps.log(`[aisle:login] sign-in window open for ${provider} at ${m.loginUrl}`);
    // Watch in the background; the HTTP request returns immediately.
    void this.watch(provider, session, m);
    return this.status(provider);
  }

  /** Manual fallback: the user clicked "I've signed in" on the page. */
  async finish(provider: string): Promise<LoginView> {
    await this.complete(provider, this.open.get(provider), false);
    return this.status(provider);
  }

  status(provider: string): LoginView {
    const view: LoginView = {
      provider,
      active: this.open.has(provider),
      loggedIn: this.done.has(provider),
    };
    const url = this.markers.get(provider)?.loginUrl;
    if (url) view.loginUrl = url;
    return view;
  }

  /** Poll the window until it looks signed in, then finalize automatically. */
  private async watch(provider: string, session: BrowserSession, m: LoginMarkers): Promise<void> {
    const deadline = Date.now() + LOGIN_WATCH_MS;
    // Give the page a moment to leave the initial (usually logged-out) state.
    await sleep(3000);
    while (this.open.get(provider) === session && Date.now() < deadline) {
      if (await this.looksLoggedIn(session.page, m).catch(() => false)) {
        await this.complete(provider, session, true);
        return;
      }
      await sleep(2000);
    }
  }

  /** Save the binding, show the success screen in the window, then close it (flushing the profile). */
  private async complete(provider: string, session: BrowserSession | undefined, showInWindow: boolean): Promise<void> {
    if (!session || this.done.has(provider)) return;
    this.done.add(provider);
    const mount = session.profile;
    if (mount) await this.deps.store.save({ userId: this.deps.userId, provider, profileId: mount.profileId });
    this.deps.log(`[aisle:login] ${provider} signed in — profile saved`);
    if (showInWindow) {
      await session.page.goto(`data:text/html,${encodeURIComponent(successHtml(provider))}`).catch(() => {});
      await sleep(6000); // let the user read the confirmation
    }
    await session.close().catch(() => {}); // flush cookies/localStorage to the userDataDir
    this.open.delete(provider);
  }

  private async present(page: PageLike, selector: string): Promise<boolean> {
    return (await page.queryAllText(selector).catch(() => [] as string[])).length > 0;
  }

  private async looksLoggedIn(page: PageLike, m: LoginMarkers): Promise<boolean> {
    if (m.loggedInSelector && (await this.present(page, m.loggedInSelector))) return true;
    // Generic positive: a visible logout / sign-out / account control appeared.
    if (
      await this.present(
        page,
        "a[href*='logout' i],a[href*='signout' i],a[href*='sign-out' i],[data-testid*='logout' i],[id*='logout' i],[class*='logout' i]",
      )
    )
      return true;
    // A configured logged-out marker that is now GONE means signed in.
    if (m.loggedOutSelector) return !(await this.present(page, m.loggedOutSelector));
    // Left the login wall.
    if (m.loginWallPattern) {
      try {
        return !new RegExp(m.loginWallPattern, "i").test(new URL(page.currentUrl()).pathname);
      } catch {
        return false;
      }
    }
    return false;
  }
}

function successHtml(provider: string): string {
  const safe = provider.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="margin:0;font:16px/1.6 system-ui,sans-serif;color:#e6edf3;background:#0b0f14;display:grid;place-items:center;height:100vh">
<div style="text-align:center;max-width:30rem;padding:2rem">
  <div style="font-size:3rem">✅</div>
  <h1 style="font-size:1.4rem;margin:.5rem 0">You're logged in to ${safe}</h1>
  <p style="opacity:.8">Aisle saved your sign-in. You can close this window and return to the agent — it will keep going on its own.</p>
  <p style="opacity:.5;font-size:.9rem">This window closes automatically…</p>
</div></body>`;
}
