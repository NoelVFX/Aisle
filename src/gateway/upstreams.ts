/**
 * Upstream vendors behind the gateway (aisle-pipeline.md §5.1).
 *
 * `upstreams.json` is the root of trust for origins: `canonicalOrigin` and
 * `billingOrigin` are the only values the policy gate ever accepts. Values may
 * reference operator environment (`${NAME}` / `${NAME:-default}`), resolved once
 * at startup. Nothing at runtime — no tool result, page, or model — can add to them.
 */

import { readFileSync } from "node:fs";
import { z, type ZodRawShape } from "zod";
import type { PurchaseOffer } from "../types.js";
import type { UpstreamConfig } from "../core/checkpoint.js";
import { canonicalize } from "../policy/policy.js";

/** How Aisle may buy from this vendor after approval. */
export interface PurchaseConfig {
  mode: "slow-lane";
  /** A real vendor with real money. Submit stays withheld unless the vendor is allowlisted. */
  realMoney: boolean;
  pricingPath?: string;
  accountPath?: string;
  /** Additional account paths to try when the vendor does not render balance on the billing page. */
  accountPaths?: string[];
  /** Optional vendor-specific selectors containing the authoritative balance. */
  balanceSelectors?: string[];
  /** Selector to click on the account page to reveal a menu-hidden balance (e.g. an avatar dropdown). */
  balanceRevealSelector?: string;
  /** Close controls for blocking modals/overlays (promo popups, cookie banners) cleared before the balance read. Escape is always tried first. */
  dismissSelectors?: string[];
  /** Page opened to begin staging when the top-up UI isn't the pricing page (defaults to pricingPath). */
  offerEntryPath?: string;
  /** Controls clicked in order to reveal menu-hidden top-up packs before staging (e.g. [profile avatar, "Top-up credits" button]). */
  offerRevealSelectors?: string[];
  loggedInSelector?: string;
  /** Match (with no logged-in marker) means logged OUT, for vendors that show "Log in / Sign up" instead of a login-wall redirect. */
  loggedOutSelector?: string;
  /** Regex (pathname) of the vendor's login wall. */
  loginWallPattern?: string;
  /**
   * "catalogue": use `offers` from this file instead of parsing the page — for
   * typed-amount top-ups. Default "page" (JSON-LD, then page text).
   */
  offersFrom?: "page" | "catalogue";
  /**
   * Payment-processor origins the checkout may redirect to (e.g. https://checkout.stripe.com).
   * The origin lock allows exactly these besides the billing origin.
   */
  paymentOrigins?: string[];
  /** Sign in with the login stored in Steel's credentials vault for the billing origin (steel.md §8). */
  steelCredentials?: boolean;
  /** Stripe TEST mode vendors only: allow Stripe's public test card on a cs_test_ Checkout Session. */
  stripeTestCard?: boolean;
  /** Drop this purchase config when the env var is unset. */
  requiresEnv?: string;
  /**
   * Vendor MCP endpoint with purchase + balance tools (fast lane, §13–§14).
   * Must be on the canonical or billing origin. Tried before the Steel browser.
   */
  mcpUrl?: string;
  /**
   * Where to actually connect for `mcpUrl` when the same server is reachable
   * locally (e.g. a vendor's MCP server behind a tunnel this machine can't resolve).
   * Operator config only, loopback only. The origin lock still checks `mcpUrl`.
   */
  mcpDialUrl?: string;
}

export interface UpstreamEntry extends UpstreamConfig {
  description: string;
  /** The billing page Steel opens. Must be on `billingOrigin`. */
  billingUrl?: string;
  /** Env var holding the vendor's API key. Never Aisle's own infra key. */
  authEnv?: string;
  /** Base URL for tool calls when the vendor runs as a separate server. */
  toolUrl?: string;
  /** Leave this vendor out entirely unless this env var is set (e.g. a demo vendor that isn't running). */
  enabledByEnv?: string;
  resource: string;
  purchase?: PurchaseConfig;
  offers: PurchaseOffer[];
}

export type Upstreams = Readonly<Record<string, Readonly<UpstreamEntry>>>;

/** `${NAME}` / `${NAME:-default}` from operator env. Trailing slashes are trimmed. */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_m, name: string, fallback: string | undefined) => {
    const v = env[name];
    if (v) return v.replace(/\/+$/, "");
    return fallback ?? "";
  });
}

function resolveDeep<T>(value: T, env: NodeJS.ProcessEnv): T {
  if (typeof value === "string") return interpolateEnv(value, env) as T;
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, env)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDeep(v, env)])) as T;
  }
  return value;
}

export function loadUpstreams(
  path: URL | string = new URL("./upstreams.json", import.meta.url),
  env: NodeJS.ProcessEnv = process.env,
): Upstreams {
  const raw = resolveDeep(JSON.parse(readFileSync(path, "utf8")) as Record<string, UpstreamEntry>, env);
  for (const [ns, up] of Object.entries(raw)) {
    if (up.enabledByEnv && !env[up.enabledByEnv]) {
      delete raw[ns];
      continue;
    }
    if (ns.includes("__")) throw new Error(`Upstream namespace '${ns}' must not contain '__'.`);
    canonicalize(up.canonicalOrigin);
    const billing = canonicalize(up.billingOrigin);
    if (up.billingUrl !== undefined && canonicalize(up.billingUrl) !== billing) {
      throw new Error(`Upstream '${ns}' billingUrl must be on its billingOrigin ${billing}.`);
    }
    if (up.toolUrl === "") delete up.toolUrl;
    if (up.purchase?.requiresEnv && !env[up.purchase.requiresEnv]) delete up.purchase;
    if (up.purchase && up.purchase.mode !== "slow-lane") {
      throw new Error(`Upstream '${ns}' purchase.mode must be "slow-lane".`);
    }
    for (const o of up.purchase?.paymentOrigins ?? []) {
      if (!o.startsWith("https://")) throw new Error(`Upstream '${ns}' purchase.paymentOrigins must be https origins.`);
      canonicalize(o);
    }
    if (up.purchase?.stripeTestCard && !(up.purchase.paymentOrigins ?? []).some((o) => canonicalize(o) === canonicalize("https://checkout.stripe.com"))) {
      throw new Error(`Upstream '${ns}' purchase.stripeTestCard needs https://checkout.stripe.com in paymentOrigins.`);
    }
    if (up.purchase?.stripeTestCard && up.purchase.realMoney) {
      throw new Error(`Upstream '${ns}' cannot use the Stripe test card on a real-money vendor.`);
    }
    if (up.purchase?.loginWallPattern) new RegExp(up.purchase.loginWallPattern); // validate early
    if (up.purchase?.mcpDialUrl !== undefined && !/^https?:\/\//.test(up.purchase.mcpDialUrl)) {
      delete (up.purchase as PurchaseConfig).mcpDialUrl; // env unset
    }
    if (up.purchase?.mcpDialUrl) {
      const host = new URL(up.purchase.mcpDialUrl).hostname;
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
        throw new Error(`Upstream '${ns}' purchase.mcpDialUrl must be a loopback address.`);
      }
    }
    if (up.purchase?.mcpUrl) {
      const mcpOrigin = canonicalize(up.purchase.mcpUrl);
      if (mcpOrigin !== billing && mcpOrigin !== canonicalize(up.canonicalOrigin)) {
        throw new Error(`Upstream '${ns}' purchase.mcpUrl must be on its canonical or billing origin.`);
      }
    }
    if (up.purchase) Object.freeze(up.purchase);
    Object.freeze(up.offers);
    Object.freeze(up);
  }
  return Object.freeze(raw);
}

/** What calling a vendor tool produced, before Aisle looks at it. */
export type UpstreamResult =
  | { ok: true; text: string }
  | { ok: false; status: number; headers: Record<string, string>; body: unknown };

export interface VendorTool {
  /** `{namespace}__{tool}` */
  name: string;
  namespace: string;
  description: string;
  inputShape: ZodRawShape;
  call(args: Record<string, unknown>): Promise<UpstreamResult>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; headers: { forEach(cb: (value: string, key: string) => void): void }; text(): Promise<string> }>;

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

async function toResult(res: Awaited<ReturnType<FetchLike>>, onOk?: (text: string) => string): Promise<UpstreamResult> {
  const text = await res.text();
  if (res.ok) return { ok: true, text: onOk ? onOk(text) : text };
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
  return { ok: false, status: res.status, headers, body: safeJson(text) };
}

const HIGGSFIELD_DEFAULT_ENDPOINT = "https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard";

function higgsfieldAuthorization(env: NodeJS.ProcessEnv): string | undefined {
  const id = env["HIGGSFIELD_API_KEY_ID"]?.trim();
  const secret = env["HIGGSFIELD_API_KEY_SECRET"]?.trim();
  if (id && secret) return `Key ${id}:${secret}`;
  const combined = env["HIGGSFIELD_API_KEY"]?.trim();
  return combined?.includes(":") ? `Key ${combined}` : undefined;
}

function higgsfieldEndpoint(env: NodeJS.ProcessEnv): string {
  const configured = env["HIGGSFIELD_API_URL"]?.trim();
  if (!configured) return HIGGSFIELD_DEFAULT_ENDPOINT;
  const url = new URL(configured);
  return url.pathname === "/" ? `${url.origin}/higgsfield-ai/soul/v2/standard` : url.toString();
}

function higgsfieldStatusUrl(endpoint: string, requestId: string): string {
  return `${new URL(endpoint).origin}/requests/${encodeURIComponent(requestId)}/status`;
}

/** higgsfield__generate_image — submit a Higgsfield generation and poll it to completion. */
export function higgsfieldTool(env: NodeJS.ProcessEnv, fetchImpl: FetchLike): VendorTool {
  return {
    name: "higgsfield__generate_image",
    namespace: "higgsfield",
    description: "Generate an image with Higgsfield (bills image credits). Returns the image URL.",
    inputShape: { prompt: z.string().min(1).describe("What the image should show.") },
    async call(args) {
      const authorization = higgsfieldAuthorization(env);
      if (!authorization) {
        return { ok: false, status: 401, headers: {}, body: { code: "missing_credentials", message: "Higgsfield API credentials are not configured." } };
      }
      const endpoint = higgsfieldEndpoint(env);
      const headers = { "Content-Type": "application/json", Authorization: authorization };
      let submitted: Awaited<ReturnType<FetchLike>>;
      try {
        submitted = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: String(args["prompt"] ?? "") }),
        });
      } catch (err) {
        return { ok: false, status: 503, headers: {}, body: { code: "connection_error", message: err instanceof Error ? err.message : String(err) } };
      }
      const submittedText = await submitted.text();
      if (!submitted.ok) {
        const responseHeaders: Record<string, string> = {};
        submitted.headers.forEach((value, key) => (responseHeaders[key.toLowerCase()] = value));
        return { ok: false, status: submitted.status, headers: responseHeaders, body: safeJson(submittedText) };
      }

      const queued = safeJson(submittedText) as { request_id?: unknown } | null;
      const requestId = typeof queued?.request_id === "string" ? queued.request_id : undefined;
      if (!requestId) return { ok: true, text: submittedText };

      const timeoutMs = Number(env["HIGGSFIELD_POLL_TIMEOUT_MS"]) || 120_000;
      const pollMs = Number(env["HIGGSFIELD_POLL_INTERVAL_MS"]) || 2_000;
      const deadline = Date.now() + timeoutMs;
      let latest: unknown = queued;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        let statusResponse: Awaited<ReturnType<FetchLike>>;
        try {
          statusResponse = await fetchImpl(higgsfieldStatusUrl(endpoint, requestId), { method: "GET", headers, body: "" });
        } catch (err) {
          return { ok: false, status: 503, headers: {}, body: { code: "connection_error", message: err instanceof Error ? err.message : String(err), request_id: requestId } };
        }
        const statusText = await statusResponse.text();
        latest = safeJson(statusText);
        if (!statusResponse.ok) {
          const responseHeaders: Record<string, string> = {};
          statusResponse.headers.forEach((value, key) => (responseHeaders[key.toLowerCase()] = value));
          return { ok: false, status: statusResponse.status, headers: responseHeaders, body: latest };
        }
        const result = latest as { status?: unknown; images?: Array<{ url?: unknown }> } | null;
        if (result?.status === "completed") {
          const imageUrl = result.images?.find((image) => typeof image.url === "string")?.url;
          return { ok: true, text: imageUrl ? `Image ready: ${imageUrl}` : statusText };
        }
        if (result?.status === "failed" || result?.status === "nsfw" || result?.status === "canceled") {
          return { ok: false, status: 422, headers: {}, body: latest };
        }
      }
      return { ok: false, status: 504, headers: {}, body: { code: "generation_timeout", message: "Higgsfield generation did not complete before the polling timeout.", request_id: requestId, latest } };
    },
  };
}

/** openai__chat — a real OpenAI chat completion with the user's key. */
export function openAiChatTool(env: NodeJS.ProcessEnv, fetchImpl: FetchLike): VendorTool {
  return {
    name: "openai__chat",
    namespace: "openai",
    description:
      "Send a prompt to the OpenAI Chat Completions API and return the model's reply. Use this whenever the user asks you to ask ChatGPT / OpenAI something.",
    inputShape: {
      prompt: z.string().describe("The user message to send."),
      model: z.string().optional().describe("OpenAI model id. Defaults to gpt-4o-mini."),
    },
    async call(args) {
      // OPENAI_BASE_URL exists for local tests only. It changes where the API call
      // goes, never where money may move: origins still come from upstreams.json.
      const base = env["OPENAI_BASE_URL"] ?? "https://api.openai.com";
      const res = await fetchImpl(`${base.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env["OPENAI_API_KEY"] ?? ""}` },
        body: JSON.stringify({
          model: typeof args["model"] === "string" && args["model"] ? args["model"] : "gpt-4o-mini",
          messages: [{ role: "user", content: String(args["prompt"] ?? "") }],
        }),
      });
      return toResult(res, (text) => {
        const body = safeJson(text) as { choices?: Array<{ message?: { content?: unknown } }> };
        const reply = body?.choices?.[0]?.message?.content;
        return typeof reply === "string" ? reply : text;
      });
    },
  };
}

/** openrouter__chat — a real OpenRouter chat completion on the user's (drained) account key. */
export function openRouterChatTool(env: NodeJS.ProcessEnv, fetchImpl: FetchLike): VendorTool {
  return {
    name: "openrouter__chat",
    namespace: "openrouter",
    description:
      "Send a prompt to a model through OpenRouter and return the reply. Use this whenever the user asks you to ask a model via OpenRouter.",
    inputShape: {
      prompt: z.string().describe("The user message to send."),
      model: z.string().optional().describe("OpenRouter model slug. Defaults to openai/gpt-4o-mini (paid)."),
      max_tokens: z.number().int().positive().optional().describe("Most tokens to generate. OpenRouter reserves credits for this up front."),
    },
    async call(args) {
      const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env["OPENROUTER_DEMO_KEY"] ?? ""}`,
          "HTTP-Referer": "https://aisle.dev",
          "X-OpenRouter-Title": "Aisle",
        },
        body: JSON.stringify({
          model: typeof args["model"] === "string" && args["model"] ? args["model"] : "openai/gpt-4o-mini",
          messages: [{ role: "user", content: String(args["prompt"] ?? "") }],
          ...(typeof args["max_tokens"] === "number" ? { max_tokens: args["max_tokens"] } : {}),
        }),
      });
      return toResult(res, (text) => {
        const body = safeJson(text) as { choices?: Array<{ message?: { content?: unknown } }> };
        const reply = body?.choices?.[0]?.message?.content;
        return typeof reply === "string" ? reply : text;
      });
    },
  };
}

/** studio__generate_image — the Stripe test-mode demo vendor (`npm run vendor:studio`). */
export function studioImageTool(toolUrl: string, env: NodeJS.ProcessEnv, fetchImpl: FetchLike): VendorTool {
  return {
    name: "studio__generate_image",
    namespace: "studio",
    description:
      "Generate one image from a prompt with Studio, an image vendor that bills in credits (400 per image). Returns the image URL.",
    inputShape: { prompt: z.string().describe("What the image should show.") },
    async call(args) {
      const res = await fetchImpl(`${toolUrl.replace(/\/+$/, "")}/v1/images/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env["STUDIO_API_KEY"] ?? ""}` },
        body: JSON.stringify({ prompt: String(args["prompt"] ?? "") }),
      });
      return toResult(res);
    },
  };
}
