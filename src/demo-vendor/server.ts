/**
 * "Studio" — a small, real demo vendor that sells image credits through
 * Stripe Checkout (test mode). Server-rendered, semantic HTML so automated
 * browsers can read it via the accessibility tree and JSON-LD.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { StripeApi } from "./stripe.js";

export interface StudioPack {
  id: string;
  credits: number;
  priceCents: number;
  label: string;
}

export const STUDIO_PACKS: readonly StudioPack[] = [
  { id: "pack_500", credits: 500, priceCents: 500, label: "500 credits" },
  { id: "pack_2000", credits: 2000, priceCents: 1500, label: "2,000 credits" },
  { id: "pack_10000", credits: 10000, priceCents: 5000, label: "10,000 credits" },
];

export interface StudioOptions {
  port?: number;
  host?: string;
  publicUrl?: string;
  stripe: StripeApi;
  apiKey: string;
  login: { email: string; password: string };
  imageCost?: number;
  startingBalance?: number;
}

export interface StudioState {
  balance: number;
  imageCost: number;
  publicUrl: string | undefined;
  customerId: string | undefined;
  testCardId: string | undefined;
  /** Checkout session id -> pack id. */
  pending: Map<string, string>;
  credited: Set<string>;
  sessions: Set<string>;
  imagesGenerated: number;
}

export interface StudioHandle {
  url: string;
  setPublicUrl(u: string): void;
  state: StudioState;
  close(): Promise<void>;
}

const ACCOUNT_ID = "acct_studio_demo";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, html: string, extraHeaders: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
  res.end(html);
}

function redirect(res: ServerResponse, location: string, extraHeaders: Record<string, string | string[]> = {}): void {
  res.writeHead(303, { location, "cache-control": "no-store", ...extraHeaders });
  res.end();
}

function safeNext(next: string | null | undefined): string | undefined {
  if (!next) return undefined;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return undefined;
  return next;
}

const CSS = `
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1b1b1b;--muted:#5f5f5f;--card:#fff;--line:#dcdcd8;--accent:#3b4cca;--ok:#1d7a3a;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ededed;--muted:#a3a3a3;--card:#1e1e1e;--line:#333;--accent:#8c9bff;--ok:#5cc47e;--err:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main,footer{max-width:960px;margin:0 auto;padding:16px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line)}
header nav{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
a{color:var(--accent)}
h1{font-size:1.6rem;margin:.5rem 0}
.brand{font-weight:700;font-size:1.2rem;text-decoration:none;color:var(--fg)}
.packs{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.price{font-size:1.5rem;font-weight:700;margin:.25rem 0}
.muted{color:var(--muted)}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button.link{background:transparent;color:var(--accent);border:none;padding:0;text-decoration:underline}
label{display:block;margin:.75rem 0 .25rem;font-weight:600}
input,textarea{font:inherit;width:100%;max-width:420px;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
.flash{padding:10px 14px;border-radius:8px;border:1px solid var(--ok);color:var(--ok)}
.error{padding:10px 14px;border-radius:8px;border:1px solid var(--err);color:var(--err)}
.balance{font-size:1.25rem}
`;

function layout(title: string, body: string, opts: { email?: string; head?: string } = {}): string {
  const nav = opts.email
    ? `<nav aria-label="Account">
  <a href="/billing">Billing</a>
  <a href="/playground">Playground</a>
  <span>Signed in as <span data-account-email>${escapeHtml(opts.email)}</span></span>
  <form method="post" action="/logout"><button type="submit" class="link">Sign out</button></form>
</nav>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Studio</title>
<style>${CSS}</style>
${opts.head ?? ""}
</head>
<body>
<header><a class="brand" href="/">Studio</a>${nav}</header>
<main>
${body}
</main>
<footer class="muted"><small>Studio demo vendor · Stripe test mode</small></footer>
</body>
</html>`;
}

export async function startStudio(opts: StudioOptions): Promise<StudioHandle> {
  const port = opts.port ?? Number(process.env["STUDIO_PORT"] ?? 8093);
  const host = opts.host ?? "127.0.0.1";
  const imageCost = opts.imageCost ?? 400;
  const stripe = opts.stripe;

  const state: StudioState = {
    balance: opts.startingBalance ?? 0,
    imageCost,
    publicUrl: opts.publicUrl ? opts.publicUrl.replace(/\/+$/, "") : undefined,
    customerId: undefined,
    testCardId: undefined,
    pending: new Map(),
    credited: new Set(),
    sessions: new Set(),
    imagesGenerated: 0,
  };

  const log = (msg: string): void => console.error(`[studio] ${msg}`);

  async function reconcileOne(sessionId: string): Promise<void> {
    if (state.credited.has(sessionId)) {
      state.pending.delete(sessionId);
      return;
    }
    try {
      const s = await stripe.retrieveCheckoutSession(sessionId);
      if (s.payment_status !== "paid") return;
      // Re-check after await: a concurrent reconcile may have credited it.
      if (state.credited.has(sessionId)) {
        state.pending.delete(sessionId);
        return;
      }
      const packId = state.pending.get(sessionId) ?? s.metadata?.["pack"];
      const pack = STUDIO_PACKS.find((p) => p.id === packId);
      if (!pack) {
        log(`session ${sessionId} paid but pack ${String(packId)} unknown; leaving pending`);
        return;
      }
      state.credited.add(sessionId);
      state.pending.delete(sessionId);
      state.balance += pack.credits;
      log(`credited ${pack.credits} credits for ${sessionId} (balance ${state.balance})`);
    } catch (err) {
      log(`reconcile ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function reconcile(): Promise<void> {
    for (const id of [...state.pending.keys()]) await reconcileOne(id);
  }

  function hasSession(req: IncomingMessage): boolean {
    const sid = parseCookies(req.headers.cookie)["studio_session"];
    return !!sid && state.sessions.has(sid);
  }

  function apiAuthorized(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (auth) {
      const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
      if (m?.[1] && safeEqual(m[1].trim(), opts.apiKey)) return true;
    }
    return hasSession(req);
  }

  function isHttps(req: IncomingMessage): boolean {
    const proto = req.headers["x-forwarded-proto"];
    const first = (Array.isArray(proto) ? proto[0] : proto)?.split(",")[0]?.trim();
    return first === "https";
  }

  function requirePage(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    if (hasSession(req)) return true;
    redirect(res, `/login?next=${encodeURIComponent(path)}`);
    return false;
  }

  function loginPage(next: string | undefined, error?: string, email = ""): string {
    const action = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
    return layout(
      "Sign in",
      `<h1>Sign in to Studio</h1>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<form method="post" action="${escapeHtml(action)}" aria-label="Sign in">
  <label for="email">Email</label>
  <input type="email" name="email" id="email" autocomplete="username" required value="${escapeHtml(email)}">
  <label for="password">Password</label>
  <input type="password" name="password" id="password" autocomplete="current-password" required>
  <p><button type="submit">Sign in</button></p>
</form>`,
    );
  }

  function billingPage(paid: boolean): string {
    const jsonLd = {
      "@context": "https://schema.org",
      "@graph": STUDIO_PACKS.map((p) => ({
        "@type": "Product",
        name: `Studio ${p.label}`,
        sku: p.id,
        description: `${p.label} for Studio image generation. One-time purchase. No subscription.`,
        offers: {
          "@type": "Offer",
          sku: p.id,
          name: p.label,
          price: (p.priceCents / 100).toFixed(2),
          priceCurrency: "USD",
          eligibleQuantity: { "@type": "QuantitativeValue", value: p.credits },
        },
      })),
    };
    const cards = STUDIO_PACKS.map(
      (p) => `<li class="card" data-pack="${p.id}">
  <article aria-labelledby="pack-${p.id}">
    <h3 id="pack-${p.id}">${escapeHtml(p.label)}</h3>
    <p class="price">${formatUsd(p.priceCents)}</p>
    <p class="muted">One-time purchase. No subscription.</p>
    <form method="post" action="/billing/checkout">
      <input type="hidden" name="pack" value="${p.id}">
      <button type="submit">Buy ${escapeHtml(p.label)}</button>
    </form>
  </article>
</li>`,
    ).join("\n");
    return layout(
      "Billing",
      `<h1>Billing</h1>
${paid ? `<p class="flash" role="status">Payment received. Your credits have been added.</p>` : ""}
<section aria-labelledby="balance-heading">
  <h2 id="balance-heading">Credit balance</h2>
  <p class="balance"><strong data-balance>${state.balance}</strong> credits</p>
  <p class="muted">Each image costs ${imageCost} credits.</p>
</section>
<section aria-labelledby="packs-heading">
  <h2 id="packs-heading">Buy credits</h2>
  <ul class="packs">
${cards}
  </ul>
</section>`,
      {
        email: opts.login.email,
        head: `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`,
      },
    );
  }

  function playgroundPage(): string {
    return layout(
      "Playground",
      `<h1>Image playground</h1>
<p class="muted">Each image costs ${imageCost} credits. Balance: <strong data-balance>${state.balance}</strong> credits.</p>
<form id="gen-form" aria-label="Generate image">
  <label for="prompt">Prompt</label>
  <textarea id="prompt" name="prompt" rows="3" required>A lighthouse at dusk, watercolor</textarea>
  <p><button type="submit" id="generate">Generate image</button></p>
</form>
<section aria-live="polite" id="result" aria-label="Result"></section>
<script>
(function(){
  var form = document.getElementById("gen-form");
  var out = document.getElementById("result");
  function show(cls, text){ out.textContent = ""; var p = document.createElement("p"); p.className = cls; if (cls === "error") p.setAttribute("role","alert"); p.textContent = text; out.appendChild(p); }
  form.addEventListener("submit", function(ev){
    ev.preventDefault();
    var prompt = document.getElementById("prompt").value;
    show("muted", "Generating...");
    fetch("/v1/images/generate", {method:"POST", credentials:"same-origin", headers:{"content-type":"application/json"}, body: JSON.stringify({prompt: prompt})})
      .then(function(r){ return r.json().then(function(j){ return {status:r.status, body:j}; }); })
      .then(function(x){
        if (x.status === 200) {
          show("flash", "Image ready: " + x.body.url + " (" + x.body.credits_remaining + " credits remaining)");
          document.querySelectorAll("[data-balance]").forEach(function(el){ el.textContent = String(x.body.credits_remaining); });
        } else {
          show("error", (x.body && x.body.error && x.body.error.message) || ("Request failed with status " + x.status));
        }
      })
      .catch(function(e){ show("error", "Request failed: " + e.message); });
  });
})();
</script>`,
      { email: opts.login.email },
    );
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://studio.local");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/healthz" && (method === "GET" || method === "HEAD")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    // ---- API ----
    if (path === "/v1/images/generate") {
      if (method !== "POST") return sendJson(res, 405, { error: { code: "method_not_allowed", message: "Use POST." } });
      if (!apiAuthorized(req)) {
        return sendJson(res, 401, { error: { code: "unauthorized", message: "Missing or invalid API key or session." } });
      }
      let prompt = "";
      try {
        const raw = await readBody(req);
        const parsed = raw ? (JSON.parse(raw) as { prompt?: unknown }) : {};
        prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
      } catch {
        return sendJson(res, 400, { error: { code: "invalid_request", message: "Body must be JSON: {\"prompt\": string}." } });
      }
      if (state.balance < imageCost) {
        return sendJson(res, 402, {
          error: {
            code: "insufficient_credits",
            message: `Insufficient credits: this image needs ${imageCost} credits, balance ${state.balance}.`,
            required_credits: imageCost,
            balance: state.balance,
          },
        });
      }
      state.balance -= imageCost;
      state.imagesGenerated += 1;
      return sendJson(res, 200, {
        url: `https://studio.example/img/${state.imagesGenerated}.png`,
        prompt,
        credits_remaining: state.balance,
      });
    }

    if (path === "/v1/credits") {
      if (method !== "GET") return sendJson(res, 405, { error: { code: "method_not_allowed", message: "Use GET." } });
      if (!apiAuthorized(req)) {
        return sendJson(res, 401, { error: { code: "unauthorized", message: "Missing or invalid API key or session." } });
      }
      await reconcile();
      return sendJson(res, 200, { data: { balance: state.balance, currency_unit: "image_credits" } });
    }

    // ---- Pages ----
    if (path === "/" && method === "GET") return redirect(res, "/billing");

    if (path === "/login") {
      const next = safeNext(url.searchParams.get("next"));
      if (method === "GET") return sendHtml(res, 200, loginPage(next));
      if (method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        const email = form.get("email") ?? "";
        const password = form.get("password") ?? "";
        const ok =
          safeEqual(email.trim().toLowerCase(), opts.login.email.toLowerCase()) && safeEqual(password, opts.login.password);
        if (!ok) return sendHtml(res, 200, loginPage(next, "Incorrect email or password.", email));
        const sid = randomBytes(24).toString("hex");
        state.sessions.add(sid);
        const cookie = `studio_session=${sid}; HttpOnly; Path=/; SameSite=Lax${isHttps(req) ? "; Secure" : ""}`;
        return redirect(res, next ?? "/billing", { "set-cookie": cookie });
      }
    }

    if (path === "/logout" && method === "POST") {
      const sid = parseCookies(req.headers.cookie)["studio_session"];
      if (sid) state.sessions.delete(sid);
      const cookie = `studio_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${isHttps(req) ? "; Secure" : ""}`;
      return redirect(res, "/login", { "set-cookie": cookie });
    }

    if ((path === "/billing" || path === "/account") && method === "GET") {
      if (!requirePage(req, res, path + url.search)) return;
      await reconcile();
      return sendHtml(res, 200, billingPage(url.searchParams.get("paid") === "1"));
    }

    if (path === "/billing/checkout" && method === "POST") {
      if (!requirePage(req, res, "/billing")) return;
      const form = new URLSearchParams(await readBody(req));
      const pack = STUDIO_PACKS.find((p) => p.id === form.get("pack"));
      if (!pack) return sendHtml(res, 400, layout("Billing", `<h1>Unknown pack</h1><p><a href="/billing">Back to billing</a></p>`));
      if (!state.publicUrl) {
        return sendHtml(
          res,
          503,
          layout("Billing", `<h1>Checkout unavailable</h1><p class="error" role="alert">Checkout is not available yet: the public URL is not configured. Try again shortly.</p><p><a href="/billing">Back to billing</a></p>`),
        );
      }
      try {
        if (!state.customerId) {
          const c = await stripe.createCustomer(opts.login.email);
          state.customerId = c.id;
        }
        if (!state.testCardId) {
          const pm = await stripe.attachTestCard(state.customerId);
          state.testCardId = pm.id;
        }
        const session = await stripe.createCheckoutSession({
          customerId: state.customerId,
          pack,
          account: ACCOUNT_ID,
          successUrl: `${state.publicUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${state.publicUrl}/billing`,
        });
        state.pending.set(session.id, pack.id);
        log(`checkout session ${session.id} created for ${pack.id}`);
        return redirect(res, session.url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`checkout failed: ${msg}`);
        return sendHtml(
          res,
          502,
          layout("Billing", `<h1>Checkout failed</h1><p class="error" role="alert">${escapeHtml(msg)}</p><p><a href="/billing">Back to billing</a></p>`, { email: opts.login.email }),
        );
      }
    }

    if (path === "/billing/success" && method === "GET") {
      const sessionId = url.searchParams.get("session_id");
      if (sessionId && state.pending.has(sessionId)) await reconcileOne(sessionId);
      return redirect(res, "/billing?paid=1");
    }

    if (path === "/playground" && method === "GET") {
      if (!requirePage(req, res, path)) return;
      return sendHtml(res, 200, playgroundPage());
    }

    if (path.startsWith("/v1/")) return sendJson(res, 404, { error: { code: "not_found", message: "Not found." } });
    sendHtml(res, 404, layout("Not found", `<h1>Not found</h1><p><a href="/billing">Go to billing</a></p>`));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`request error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: { code: "internal_error", message: "Internal error." } });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const urlHost = host.includes(":") ? `[${host}]` : host;

  return {
    url: `http://${urlHost}:${addr.port}`,
    state,
    setPublicUrl(u: string) {
      state.publicUrl = u.replace(/\/+$/, "");
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
