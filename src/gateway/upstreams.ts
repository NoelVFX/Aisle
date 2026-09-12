/**
 * Upstream vendors behind the gateway (aisle-pipeline.md §5.1).
 *
 * `upstreams.json` is the root of trust for origins: `canonicalOrigin` and
 * `billingOrigin` are the only values the policy gate ever accepts, and nothing
 * at runtime can add to them. The tools here only decide how to CALL a vendor.
 */

import { readFileSync } from "node:fs";
import { z, type ZodRawShape } from "zod";
import type { PurchaseOffer } from "../types.js";
import type { UpstreamConfig } from "../core/checkpoint.js";
import { canonicalize } from "../policy/policy.js";

export interface UpstreamEntry extends UpstreamConfig {
  description: string;
  /** Env var holding the vendor's API key. Never Aisle's own infra key. */
  authEnv?: string;
  /** Resource the vendor's walls are measured in (e.g. usd_balance). */
  resource: string;
  offers: PurchaseOffer[];
}

export type Upstreams = Readonly<Record<string, Readonly<UpstreamEntry>>>;

export function loadUpstreams(path: URL | string = new URL("./upstreams.json", import.meta.url)): Upstreams {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, UpstreamEntry>;
  for (const [ns, up] of Object.entries(raw)) {
    if (ns.includes("__")) throw new Error(`Upstream namespace '${ns}' must not contain '__'.`);
    canonicalize(up.canonicalOrigin);
    canonicalize(up.billingOrigin);
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
      const text = await res.text();
      if (res.ok) {
        const body = safeJson(text) as { choices?: Array<{ message?: { content?: unknown } }> };
        const reply = body?.choices?.[0]?.message?.content;
        return { ok: true, text: typeof reply === "string" ? reply : text };
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
      return { ok: false, status: res.status, headers, body: safeJson(text) };
    },
  };
}

/** In-process mock image vendor (the scaffold's mock-vendor, without a server). */
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
      description:
        "Generate one image from a prompt with the mock image vendor. Each image costs 1,067 credits. Returns the image URL.",
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
