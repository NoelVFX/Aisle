/**
 * Link-based, one-time vendor sign-in — the friendly alternative to `npm run login`.
 *
 * When Aisle needs a vendor the user hasn't signed in to, it hands back a link
 * (served by the approval server). Opening it launches a real sign-in window in
 * that vendor's PERSISTENT profile; the user logs in and clicks "done"; Aisle
 * flushes the profile and records the (user, vendor) binding. Every later
 * top-up/action reuses it — no login again, like a connected MCP.
 *
 * The password is never seen by Aisle: it is typed into the vendor's own page.
 */

import { existsSync } from "node:fs";
import { LocalBrowserProvider } from "../slow-lane/local-provider.js";
import { FileProfileStore, profileDirFor } from "../slow-lane/profiles.js";
import type { BrowserSession } from "../slow-lane/browser.js";

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
  private readonly pending = new Map<string, string>(); // provider -> sign-in URL

  constructor(private readonly deps: LoginManagerDeps) {}

  /** Record where to open the sign-in page for a vendor (set when LOGIN_REQUIRED is returned). */
  register(provider: string, loginUrl: string): void {
    this.pending.set(provider, loginUrl);
  }

  async isLoggedIn(provider: string): Promise<boolean> {
    if ((await this.deps.store.load(this.deps.userId, provider)) !== undefined) return true;
    // A profile dir with content (e.g. from a prior `npm run login`) also counts.
    return existsSync(profileDirFor(this.deps.profilesDir, provider));
  }

  /** Open a headed sign-in window for the vendor and leave it open until finish(). */
  async start(provider: string, loginUrl?: string): Promise<LoginView> {
    if (this.open.has(provider)) return this.status(provider);
    const url = loginUrl ?? this.pending.get(provider);
    if (!url) throw new Error("NO_LOGIN_URL: unknown where to sign in for this vendor.");
    this.pending.set(provider, url);
    const browser = new LocalBrowserProvider({ profilesDir: this.deps.profilesDir, headed: true });
    const session = await browser.createSession({ provider });
    this.open.set(provider, session);
    await session.page.goto(url).catch(() => {});
    this.deps.log(`[aisle:login] sign-in window open for ${provider} at ${url}`);
    return this.status(provider);
  }

  /** Close the sign-in window (which flushes the profile) and record the binding. */
  async finish(provider: string): Promise<LoginView> {
    const session = this.open.get(provider);
    if (session) {
      const mount = session.profile;
      await session.close();
      if (mount) await this.deps.store.save({ userId: this.deps.userId, provider, profileId: mount.profileId });
      this.open.delete(provider);
      this.deps.log(`[aisle:login] saved ${provider} profile`);
    }
    return this.status(provider);
  }

  status(provider: string): LoginView {
    const view: LoginView = {
      provider,
      active: this.open.has(provider),
      loggedIn: existsSync(profileDirFor(this.deps.profilesDir, provider)),
    };
    const url = this.pending.get(provider);
    if (url) view.loginUrl = url;
    return view;
  }
}
