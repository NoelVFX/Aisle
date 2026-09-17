/** Scoped human takeover (steel.md §8, §16.3): sign-in and checkout challenges. */

import { describe, it, expect } from "vitest";
import { runSlowLane } from "../src/slow-lane/executor.js";
import { LadderVendorAdapter } from "../src/slow-lane/adapters/ladder-adapter.js";
import { InMemoryAdapterRegistry } from "../src/slow-lane/adapters/recorded-adapter.js";
import { TakeoverRequiredError } from "../src/errors.js";
import type { PageLike } from "../src/slow-lane/browser.js";
import type { TakeoverContext } from "../src/slow-lane/executor.js";
import { FakeBrowserProvider, FakeShopAdapter, FakeShopSite } from "./helpers/fake-shop.js";
import { makeRequest, SECRET } from "./fixtures.js";

const PROVIDER = "takeover-vendor";
const ORIGIN = "https://shop.takeover-vendor.test";

describe("sign-in takeover", () => {
  it("hands a sign-in the automation can't do to the human, then buys in the same session", async () => {
    const site = new FakeShopSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0, sessionExpired: true, reauthFails: true });
    const events: string[] = [];
    const seen: TakeoverContext[] = [];
    await runSlowLane(makeRequest({ provider: PROVIDER, origin: ORIGIN }), {
      provider: new FakeBrowserProvider(site),
      adapter: new FakeShopAdapter(site),
      mandateSecret: SECRET,
      emit: (e) => events.push(e.type),
      onTakeover: async (ctx) => {
        seen.push(ctx);
        site.loggedIn = true; // the human signed in inside the Steel browser
      },
    });
    expect(seen.map((c) => c.reason)).toEqual(["LOGIN_REQUIRED"]);
    expect(events.indexOf("TAKEOVER_REQUESTED")).toBeLessThan(events.indexOf("TAKEOVER_RESOLVED"));
    expect(events.indexOf("TAKEOVER_RESOLVED")).toBeLessThan(events.indexOf("PURCHASE_SUBMITTED"));
    expect(site.purchaseClicks).toBe(1);
  });

  it("still stops with NOT_AUTHENTICATED when the human doesn't sign in", async () => {
    const site = new FakeShopSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0, sessionExpired: true, reauthFails: true });
    await expect(
      runSlowLane(makeRequest({ provider: PROVIDER, origin: ORIGIN }), {
        provider: new FakeBrowserProvider(site),
        adapter: new FakeShopAdapter(site),
        mandateSecret: SECRET,
        onTakeover: async () => {},
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHENTICATED" });
    expect(site.purchaseClicks).toBe(0);
  });
});

describe("ladder adapter takeover hooks", () => {
  const adapter = () =>
    new LadderVendorAdapter({
      provider: "openrouter",
      billingOrigin: "https://openrouter.ai",
      loginWallPattern: /^\/(sign-in|sign-up|login)/i,
      registry: new InMemoryAdapterRegistry(),
    });

  it("treats OpenRouter's sign-in redirect and SSO hosts as the login wall, the credits page as signed in", () => {
    const a = adapter();
    // Seen live: logged-out /settings/credits lands here.
    expect(a.onLoginWall("https://openrouter.ai/sign-in?redirect_url=https%3A%2F%2Fopenrouter.ai%2Fsettings%2Fcredits")).toBe(true);
    expect(a.onLoginWall("https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toBe(true);
    expect(a.onLoginWall("https://openrouter.ai/settings/credits")).toBe(false);
  });

  it("a 3-D Secure screen after the pay click is a takeover, cleared once it's gone", async () => {
    let text = "";
    const page = {
      currentUrl: () => "https://openrouter.ai/settings/credits",
      clickByRole: async () => {
        text = "Complete your purchase. 3D Secure: confirm this payment in your banking app.";
        return true;
      },
      settle: async () => {},
      queryAllText: async () => [],
      innerText: async () => text,
    } as unknown as PageLike;
    const a = adapter();
    const staged = { lineItem: "$5 credits", amount: 5, currency: "USD", billingPeriod: "one_time" as const, autoRenew: false };
    await expect(a.confirmPurchase(page, staged)).rejects.toBeInstanceOf(TakeoverRequiredError);
    expect(await a.challengeCleared(page)).toBe(false);
    text = "Credits $5.00";
    expect(await a.challengeCleared(page)).toBe(true);
  });
});
