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
  loggedInSelector?: string;
  /** Regex (pathname) of the vendor's login wall. */
  loginWallPattern?: string;
  /** Drop this purchase config when the env var is unset. */
  requiresEnv?: string;
}

export interface UpstreamEntry extends UpstreamConfig {
  description: string;
  /** The billing page Steel opens. Must be on `billingOrigin`. */
  billingUrl?: string;
  /** Env var holding the vendor's API key. Never Aisle's own infra key. */
  authEnv?: string;
  /** Base URL for tool calls when the vendor runs as a separate server. */
  toolUrl?: string;
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
    if (ns.includes("__")) throw new Error(`Upstream namespace '${ns}' must not contain '__'.`);
    canonicalize(up.canonicalOrigin);
    const billing = canonicalize(up.billingOrigin);
    if (up.billingUrl !== undefined && canonicalize(up.billingUrl) !== billing) {
      throw new Error(`Upstream '${ns}' billingUrl must be on its billingOrigin ${billing}.`);
    }
    if (up.toolUrl === "") delete up.toolUrl;
    if (up.purchase?.requiresEnv && !env[up.purchase.requiresEnv]) delete up.purchase;
    if (up.purchase?.loginWallPattern) new RegExp(up.purchase.loginWallPattern); // validate early
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

const IMAGE_TOOL_DESCRIPTION =
  "Generate one image from a prompt with the mock image vendor. Each image costs 1,067 credits. Returns the image URL.";

/** mockvendor__generate_image against the mock vendor website (`npm run mock:vendor`). */
export function mockVendorHttpTool(toolUrl: string, fetchImpl: FetchLike): VendorTool {
  return {
    name: "mockvendor__generate_image",
    namespace: "mockvendor",
    description: IMAGE_TOOL_DESCRIPTION,
    inputShape: { prompt: z.string().describe("What the image should show.") },
    async call(args) {
      const res = await fetchImpl(`${toolUrl}/tools/generate_image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: String(args["prompt"] ?? "") }),
      });
      return toResult(res);
    },
  };
}

/** In-process mock image vendor, used when the mock website isn't running. */
export class MockImageVendor {
  static readonly COST = 1067;
  balance: number;
  generated = 0;

  constructor(startingBalance = 0) {
    this.balance = startingBalance;
  }

  credit(units: number): void {
    this.balance += units;
  }

  tool(): VendorTool {
    return {
      name: "mockvendor__generate_image",
      namespace: "mockvendor",
      description: IMAGE_TOOL_DESCRIPTION,
      inputShape: { prompt: z.string().describe("What the image should show.") },
      call: async (args) => {
        if (this.balance < MockImageVendor.COST) {
          return {
            ok: false,
            status: 402,
            headers: {},
            body: { code: "insufficient_credits", required_credits: MockImageVendor.COST, balance: this.balance },
          };
        }
        this.balance -= MockImageVendor.COST;
        this.generated += 1;
        return {
          ok: true,
          text: JSON.stringify({
            url: `https://cdn.mockvendor.aisle.test/img/${this.generated}.png`,
            prompt: String(args["prompt"] ?? ""),
            credits_remaining: this.balance,
          }),
        };
      },
    };
  }
}
