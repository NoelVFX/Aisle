import { describe, it, expect, afterEach } from "vitest";
import { request } from "node:http";
import { startStudio, STUDIO_PACKS, type StudioHandle } from "../src/demo-vendor/server.js";
import { createStripeApi, encodeForm, type StripeApi } from "../src/demo-vendor/stripe.js";

const API_KEY = "sk_studio_test";
const LOGIN = { email: "demo@studio.test", password: "hunter2-correct" };

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(base: string, method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const req = request(u, { method, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function fakeStripe() {
  const calls = { customers: 0, attach: 0, sessions: [] as Array<Parameters<StripeApi["createCheckoutSession"]>[0]>, retrieves: 0 };
  const paid = new Set<string>();
  let n = 0;
  const stripe: StripeApi = {
    async createCustomer() {
      calls.customers++;
      return { id: "cus_fake" };
    },
    async attachTestCard() {
      calls.attach++;
      return { id: "pm_fake" };
    },
    async createCheckoutSession(p) {
      calls.sessions.push(p);
      n++;
      return { id: `cs_test_${n}`, url: `https://checkout.stripe.test/c/cs_test_${n}` };
    },
    async retrieveCheckoutSession(id) {
      calls.retrieves++;
      return { id, payment_status: paid.has(id) ? "paid" : "unpaid" };
    },
  };
  return { stripe, calls, paid };
}

let handle: StudioHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function start(stripe: StripeApi, publicUrl?: string) {
  handle = await startStudio({ port: 0, stripe, apiKey: API_KEY, login: LOGIN, publicUrl });
  return handle;
}

async function signIn(base: string): Promise<string> {
  const r = await send(base, "POST", "/login", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(LOGIN).toString(),
  });
  const setCookie = r.headers["set-cookie"];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (first ?? "").split(";")[0] ?? "";
}

const bearer = { authorization: `Bearer ${API_KEY}` };

describe("Studio API", () => {
  it("returns 402 with insufficient_credits when balance is 0, and 401 without auth", async () => {
    const h = await start(fakeStripe().stripe);
    expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await send(h.url, "POST", "/v1/images/generate", {
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    expect(r.status).toBe(402);
    expect(JSON.parse(r.body)).toEqual({
      error: {
        code: "insufficient_credits",
        message: "Insufficient credits: this image needs 400 credits, balance 0.",
        required_credits: 400,
        balance: 0,
      },
    });
    const u = await send(h.url, "POST", "/v1/images/generate", { body: JSON.stringify({ prompt: "x" }) });
    expect(u.status).toBe(401);
    expect(JSON.parse(u.body).error.code).toBe("unauthorized");
    const bad = await send(h.url, "GET", "/v1/credits", { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
    expect((await send(h.url, "GET", "/healthz")).body).toBe("ok");
  });

  it("GET /v1/credits returns balance shape", async () => {
    const h = await start(fakeStripe().stripe);
    const r = await send(h.url, "GET", "/v1/credits", { headers: bearer });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ data: { balance: 0, currency_unit: "image_credits" } });
  });
});

describe("Studio web", () => {
  it("login flow and billing page", async () => {
    const h = await start(fakeStripe().stripe);
    const gate = await send(h.url, "GET", "/billing");
    expect(gate.status).toBe(303);
    expect(gate.headers.location).toBe("/login?next=%2Fbilling");

    const loginPage = await send(h.url, "GET", "/login");
    expect(loginPage.body).toContain('<input type="email" name="email" id="email" autocomplete="username"');
    expect(loginPage.body).toContain('<input type="password" name="password" id="password" autocomplete="current-password"');
    expect(loginPage.body).toContain('<button type="submit">Sign in</button>');

    const wrong = await send(h.url, "POST", "/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: LOGIN.email, password: "nope" }).toString(),
    });
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    expect(wrong.body).toContain("Incorrect email or password");
    expect(wrong.body).toContain('id="password"');

    const ok = await send(h.url, "POST", "/login?next=%2Fplayground", {
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" },
      body: new URLSearchParams(LOGIN).toString(),
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe("/playground");
    const sc = String(ok.headers["set-cookie"]);
    expect(sc).toMatch(/studio_session=[0-9a-f]+; HttpOnly; Path=\/; SameSite=Lax; Secure/);

    const evil = await send(h.url, "POST", "/login?next=%2F%2Fevil.com", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(LOGIN).toString(),
    });
    expect(evil.headers.location).toBe("/billing");
    expect(String(evil.headers["set-cookie"])).not.toContain("Secure");

    const cookie = await signIn(h.url);
    const billing = await send(h.url, "GET", "/billing?paid=1", { headers: { cookie } });
    expect(billing.status).toBe(200);
    expect(billing.body).toContain("<strong data-balance>0</strong> credits");
    expect(billing.body).toContain(`<span data-account-email>${LOGIN.email}</span>`);
    expect(billing.body).toContain("Payment received");
    expect(billing.body).toContain('<button type="submit">Buy 500 credits</button>');
    expect(billing.body).toContain("$5.00");
    expect(billing.body).toContain("One-time purchase. No subscription.");

    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(billing.body);
    expect(m).not.toBeNull();
    const ld = JSON.parse(m?.[1] ?? "{}") as { "@graph": Array<{ "@type": string; offers: Record<string, unknown> }> };
    const offers = ld["@graph"].map((p) => p.offers);
    expect(offers).toHaveLength(3);
    expect(offers[0]).toEqual({
      "@type": "Offer",
      sku: "pack_500",
      name: "500 credits",
      price: "5.00",
      priceCurrency: "USD",
      eligibleQuantity: { "@type": "QuantitativeValue", value: 500 },
    });

    const account = await send(h.url, "GET", "/account", { headers: { cookie } });
    expect(account.body).toContain("data-balance");
    const pg = await send(h.url, "GET", "/playground", { headers: { cookie } });
    expect(pg.body).toContain("Generate image");
  });

  it("checkout creates customer and card once, reconciles exactly once, then generate succeeds", async () => {
    const { stripe, calls, paid } = fakeStripe();
    const h = await start(stripe);
    const cookie = await signIn(h.url);
    const form = { "content-type": "application/x-www-form-urlencoded", cookie };

    const noUrl = await send(h.url, "POST", "/billing/checkout", { headers: form, body: "pack=pack_500" });
    expect(noUrl.status).toBe(503);

    h.setPublicUrl("https://studio.trycloudflare.com/");
    const c1 = await send(h.url, "POST", "/billing/checkout", { headers: form, body: "pack=pack_500" });
    expect(c1.status).toBe(303);
    expect(c1.headers.location).toBe("https://checkout.stripe.test/c/cs_test_1");
    const c2 = await send(h.url, "POST", "/billing/checkout", { headers: form, body: "pack=pack_2000" });
    expect(c2.headers.location).toBe("https://checkout.stripe.test/c/cs_test_2");

    expect(calls.customers).toBe(1);
    expect(calls.attach).toBe(1);
    expect(calls.sessions).toHaveLength(2);
    const s1 = calls.sessions[0];
    expect(s1?.customerId).toBe("cus_fake");
    expect(s1?.pack).toEqual(STUDIO_PACKS[0]);
    expect(s1?.pack.priceCents).toBe(500);
    expect(s1?.successUrl).toBe("https://studio.trycloudflare.com/billing/success?session_id={CHECKOUT_SESSION_ID}");
    expect(s1?.cancelUrl).toBe("https://studio.trycloudflare.com/billing");
    expect(h.state.pending.size).toBe(2);

    // Unpaid: stays pending.
    let r = await send(h.url, "GET", "/v1/credits", { headers: bearer });
    expect(JSON.parse(r.body).data.balance).toBe(0);
    expect(h.state.pending.size).toBe(2);

    paid.add("cs_test_1");
    r = await send(h.url, "GET", "/v1/credits", { headers: bearer });
    expect(JSON.parse(r.body).data.balance).toBe(500);
    r = await send(h.url, "GET", "/v1/credits", { headers: bearer });
    expect(JSON.parse(r.body).data.balance).toBe(500);
    const succ = await send(h.url, "GET", "/billing/success?session_id=cs_test_1");
    expect(succ.headers.location).toBe("/billing?paid=1");
    expect(h.state.balance).toBe(500);
    expect(h.state.credited.has("cs_test_1")).toBe(true);
    expect(h.state.pending.has("cs_test_2")).toBe(true);

    const gen = await send(h.url, "POST", "/v1/images/generate", {
      headers: { ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a fox" }),
    });
    expect(gen.status).toBe(200);
    expect(JSON.parse(gen.body)).toEqual({ url: "https://studio.example/img/1.png", prompt: "a fox", credits_remaining: 100 });

    // Session cookie also authorizes the API.
    const viaCookie = await send(h.url, "GET", "/v1/credits", { headers: { cookie } });
    expect(JSON.parse(viaCookie.body).data.balance).toBe(100);
  });

  it("reconcile survives Stripe errors", async () => {
    const { stripe } = fakeStripe();
    const h = await start({ ...stripe, retrieveCheckoutSession: async () => { throw new Error("boom"); } }, "https://x.test");
    const cookie = await signIn(h.url);
    await send(h.url, "POST", "/billing/checkout", { headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: "pack=pack_500" });
    const r = await send(h.url, "GET", "/v1/credits", { headers: bearer });
    expect(r.status).toBe(200);
    expect(h.state.pending.size).toBe(1);
  });
});

describe("stripe.ts", () => {
  it("refuses non sk_test_ keys", () => {
    expect(() => createStripeApi("sk_live_abc")).toThrow(/test mode/);
    expect(() => createStripeApi("rk_test_abc")).toThrow(/test mode/);
    expect(() => createStripeApi("sk_test_abc")).not.toThrow();
  });

  it("encodes nested keys", () => {
    const s = encodeForm({
      mode: "payment",
      line_items: [{ price_data: { currency: "usd", unit_amount: 500, product_data: { name: "Studio 500 credits" } }, quantity: 1 }],
      payment_method_types: ["card"],
      metadata: { pack: "pack_500" },
      success_url: "https://x.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
    });
    const params = new URLSearchParams(s);
    expect(params.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(params.get("line_items[0][price_data][unit_amount]")).toBe("500");
    expect(params.get("line_items[0][price_data][product_data][name]")).toBe("Studio 500 credits");
    expect(params.get("line_items[0][quantity]")).toBe("1");
    expect(params.get("payment_method_types[0]")).toBe("card");
    expect(params.get("metadata[pack]")).toBe("pack_500");
    expect(params.get("success_url")).toBe("https://x.test/billing/success?session_id={CHECKOUT_SESSION_ID}");
  });

  it("sends form bodies with bearer auth and surfaces Stripe errors", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      if (String(url).endsWith("/checkout/sessions/cs_bad")) {
        return new Response(JSON.stringify({ error: { message: "No such checkout.session: cs_bad" } }), { status: 404 });
      }
      return new Response(JSON.stringify({ id: String(url).includes("attach") ? "pm_123" : "cus_1" }), { status: 200 });
    }) as typeof fetch;
    const api = createStripeApi("sk_test_x", fetchImpl);
    expect(await api.attachTestCard("cus_1")).toEqual({ id: "pm_123" });
    expect(seen[0]?.url).toBe("https://api.stripe.com/v1/payment_methods/pm_card_visa/attach");
    expect(seen[0]?.init?.body).toBe("customer=cus_1");
    expect((seen[0]?.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer sk_test_x");
    expect(seen[1]?.url).toBe("https://api.stripe.com/v1/payment_methods/pm_123");
    expect(seen[1]?.init?.body).toBe("allow_redisplay=always");
    await expect(api.retrieveCheckoutSession("cs_bad")).rejects.toThrow(/No such checkout.session/);
  });
});
