/** Real-vendor pipeline: entitlement check before the quote, /browse approvals, Stripe checkout, API Gate 2. */

import { describe, it, expect } from "vitest";
import { createGateway } from "../src/gateway/gateway.js";
import { loadUpstreams, type FetchLike } from "../src/gateway/upstreams.js";
import { createBalanceReaders, type GetJson } from "../src/gateway/balances.js";
import type { SteelRunner } from "../src/gateway/recovery.js";
import { LadderVendorAdapter } from "../src/slow-lane/adapters/ladder-adapter.js";
import { InMemoryAdapterRegistry } from "../src/slow-lane/adapters/recorded-adapter.js";
import type { PageLike } from "../src/slow-lane/browser.js";

const json = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content[0]?.text ?? "{}");
const steel: SteelRunner = {
  async run({ billingUrl }) {
    return { sessionId: "s", debugUrl: undefined, viewerUrl: undefined, finalUrl: billingUrl, title: undefined, screenshotPath: undefined };
  },
};
const noCredits: FetchLike = async () => ({
  ok: false,
  status: 402,
  headers: { forEach: () => {} },
  text: async () => JSON.stringify({ error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits" } }),
});

function openRouterGateway(balance: number | undefined) {
  return createGateway({
    upstreams: loadUpstreams(undefined, {}),
    steel,
    env: { OPENROUTER_DEMO_KEY: "sk-or-drained" },
    fetchImpl: noCredits,
    balanceReaders: balance === undefined ? {} : { openrouter: async () => balance },
    approveUrlFor: (id, surface) => (surface === "cli" ? "http://127.0.0.1:8797/browse" : `http://127.0.0.1:8797/r/${id}`),
    safeBlockMs: 30,
    pollMs: 5,
    publicUrl: () => "http://127.0.0.1:8797",
    mandateSecret: "real-pipeline",
    log: () => {},
  });
}

describe("balance readers (read balance, not receipt)", () => {
  it("reads OpenRouter credits minus usage and Studio's balance, only with a key", async () => {
    const urls: string[] = [];
    const fetchJson: GetJson = async (url) => {
      urls.push(url);
      return { ok: true, json: async () => (url.includes("openrouter") ? { data: { total_credits: 10, total_usage: 4.25 } } : { data: { balance: 900 } }) };
    };
    const upstreams = loadUpstreams(undefined, { STUDIO_PUBLIC_URL: "https://studio.trycloudflare.com", STUDIO_URL: "http://127.0.0.1:8093" });
    const readers = createBalanceReaders(upstreams, { OPENROUTER_DEMO_KEY: "k", STUDIO_API_KEY: "s" }, fetchJson);
    expect(await readers["openrouter"]?.()).toBe(5.75);
    expect(await readers["studio"]?.()).toBe(900);
    expect(urls).toEqual(["https://openrouter.ai/api/v1/credits", "http://127.0.0.1:8093/v1/credits"]);
    expect(Object.keys(createBalanceReaders(upstreams, {}, fetchJson))).toEqual([]);
  });
});

describe("entitlement check before the quote (§8)", () => {
  it("a 402 with enough balance is ALREADY_COVERED: retried, nothing quoted or bought", async () => {
    const g = openRouterGateway(12);
    await g.callTool("openrouter__chat", { prompt: "2+2" }, { taskId: "t" });
    const job = g.coordinator.list()[0]!;
    expect(job.events.map((e) => e.type)).toEqual(expect.arrayContaining(["ENTITLEMENT_CHECKED", "ALREADY_COVERED"]));
    expect(job.events.map((e) => e.type)).not.toContain("QUOTE_CREATED");
    expect(job.mandate).toBeUndefined();
  });

  it("a real shortfall quotes, gates and signs, and the CLI link is /browse", async () => {
    const g = openRouterGateway(0);
    const first = json((await g.callTool("openrouter__chat", { prompt: "2+2" }, { taskId: "t" })) as never);
    expect(first.status).toBe("AWAITING_APPROVAL");
    expect(first.approve_url).toBe("http://127.0.0.1:8797/browse");
    const types = g.coordinator.get(first.recovery_id)!.events.map((e) => e.type);
    expect(types.indexOf("ENTITLEMENT_CHECKED")).toBeLessThan(types.indexOf("QUOTE_CREATED"));
    expect(types.indexOf("POLICY_PASSED")).toBeLessThan(types.indexOf("MANDATE_SIGNED"));

    const status = g.recoveryStatus("t");
    expect(status.structuredContent).toMatchObject({ recovery_id: first.recovery_id, status: "awaiting_approval", vendor: "openrouter", approve_url: "http://127.0.0.1:8797/browse" });
    expect(g.recoveryStatus("someone-else").structuredContent).toEqual({ status: "NO_RECOVERY" });
  });
});

describe("Studio vendor config", () => {
  it("is present only while the demo vendor runs, with Stripe as the one payment origin", () => {
    expect(loadUpstreams(undefined, {})["studio"]).toBeUndefined();
    const studio = loadUpstreams(undefined, { STUDIO_PUBLIC_URL: "https://studio.trycloudflare.com", STUDIO_URL: "http://127.0.0.1:8093" })["studio"]!;
    expect(studio.billingUrl).toBe("https://studio.trycloudflare.com/billing");
    expect(studio.purchase).toMatchObject({ realMoney: false, stripeTestCard: true, paymentOrigins: ["https://checkout.stripe.com"] });
  });
});

describe("Stripe Checkout in the slow lane", () => {
  const staged = { lineItem: "500 credits", amount: 5, currency: "USD", billingPeriod: "one_time" as const, autoRenew: false };
  function stripePage(url: string, cardFields: boolean) {
    const filled: Array<[string, string]> = [];
    const page = {
      currentUrl: () => url,
      waitForSelector: async (sel: string) => {
        if (sel.startsWith("#") && !cardFields) throw new Error("not visible");
      },
      fill: async (sel: string, value: string) => void filled.push([sel, value]),
      clickByRole: async (_role: string, name: string | RegExp) => name === "Pay",
      settle: async () => {},
      queryAllText: async () => [],
      innerText: async () => "",
    } as unknown as PageLike;
    return { page, filled };
  }
  const adapter = (events: string[], balanceReader?: () => Promise<number | undefined>) =>
    new LadderVendorAdapter({
      provider: "studio",
      billingOrigin: "https://studio.trycloudflare.com",
      paymentOrigins: ["https://checkout.stripe.com"],
      stripeTestCard: true,
      registry: new InMemoryAdapterRegistry(),
      onEvent: (t) => events.push(t),
      ...(balanceReader ? { balanceReader, balanceSettleMs: 10_000 } : {}),
    });

  it("types Stripe's public test card only on a test-mode session, then clicks Pay", async () => {
    const events: string[] = [];
    const { page, filled } = stripePage("https://checkout.stripe.com/c/pay/cs_test_a1b2#fid", true);
    await adapter(events).confirmPurchase(page, staged);
    expect(filled[0]).toEqual(["#cardNumber", "4242424242424242"]);
    expect(events).toEqual(expect.arrayContaining(["TEST_CARD_ENTERED", "CONFIRM_CLICKED"]));
  });

  it("uses the saved card when Stripe shows no card fields", async () => {
    const events: string[] = [];
    const { page, filled } = stripePage("https://checkout.stripe.com/c/pay/cs_test_a1b2", false);
    await adapter(events).confirmPurchase(page, staged);
    expect(filled).toEqual([]);
    expect(events).toContain("SAVED_CARD_USED");
  });

  it("refuses the test card on a live-mode session before clicking anything", async () => {
    const events: string[] = [];
    const { page, filled } = stripePage("https://checkout.stripe.com/c/pay/cs_live_a1b2", true);
    await expect(adapter(events).confirmPurchase(page, staged)).rejects.toMatchObject({ code: "TEST_CARD_OUTSIDE_TEST_MODE" });
    expect(filled).toEqual([]);
    expect(events).not.toContain("CONFIRM_CLICKED");
  });

  it("Gate 2 reads the vendor API and waits for the balance to move after Pay", async () => {
    const readings = [0, 0, 500];
    const events: string[] = [];
    const a = adapter(events, async () => readings.shift() ?? 500);
    const { page } = stripePage("https://checkout.stripe.com/c/pay/cs_test_a1b2", false);
    const req = { resource: "image_credits", amount: 400 };
    expect((await a.verifyEntitlement(page, req)).balanceAfter).toBe(0);
    await a.confirmPurchase(page, staged);
    const after = await a.verifyEntitlement(page, req);
    expect(after).toMatchObject({ balanceAfter: 500, confirmed: true });
  });
});
