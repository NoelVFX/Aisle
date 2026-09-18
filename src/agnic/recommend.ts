/**
 * The recommendation layer: goal → the best-fit MCP tool / SaaS + its checkout URL.
 *
 * This is the half of the workflow that Agnic does NOT do. Agnic's product search
 * indexes vetted Shopify shops (physical goods), not SaaS/MCP subscriptions — so
 * "which tool sends email autonomously?" is an LLM judgement, not a product query.
 * This module asks an OpenRouter model (Qwen 3.7 by default) to name the tool and
 * return its canonical pricing/checkout URL; the agent then feeds that url into
 * `aisle__shop` as `explore_url`, and Agnic completes the real checkout there.
 *
 *   goal → recommendTool() → { tool_name, checkout_url, plan_hint?, … }
 *        → aisle__shop{ explore_url, plan_hint } → CHOOSE_PLAN (user picks) → … → receipt
 *
 * The model only NAMES a tool, a URL and (optionally) a plan to suggest; it never
 * pays, never touches a page, and never picks the sku — that comes from Agnic.
 */

import type { OpenRouterFetch } from "../slow-lane/computer-use.js";
import { OPENROUTER_REQUEST_TIMEOUT_MS } from "../slow-lane/computer-use.js";

export interface ToolAlternative {
  tool_name: string;
  why: string;
}

export interface ToolRecommendation {
  /** The recommended product, e.g. "Resend". */
  tool_name: string;
  /** The company/vendor behind it (often == tool_name). */
  vendor: string;
  /** What it is, e.g. "Transactional email API". */
  category: string;
  /** One line on why it fits the goal. */
  why: string;
  /** Canonical pricing/checkout page — feed this to aisle__shop as explore_url. */
  checkout_url: string;
  /**
   * The plan that likely fits, e.g. "Pro" or "Pro (~$20/month)" — feed this to
   * aisle__shop as plan_hint. A suggestion only: the user still picks the plan.
   */
  plan_hint?: string;
  /** Whether the tool ships an MCP server (best-effort model knowledge). */
  has_mcp: boolean;
  /** Runner-up options the user might prefer. */
  alternatives: ToolAlternative[];
  /** The OpenRouter model that actually answered (cost attribution / debugging). */
  model_used?: string;
  /** Set when checkout_url wasn't a usable https URL — the agent should confirm before buying. */
  url_warning?: string;
}

/**
 * Recommendation profile. Qwen 3.7 Max leads (strong instruction-following, cheap,
 * good product knowledge, verified in the live catalogue for the picker). The
 * fallbacks are what OpenRouter routes to if the primary is rate-limited or a slug
 * goes stale; the last is a free model so a spent key still answers.
 */
export const RECOMMEND_PROFILE = {
  model: "qwen/qwen3.7-max",
  models: [
    "qwen/qwen3.8-max-0902",
    "deepseek/deepseek-chat-v3.1:free",
  ] as readonly string[],
} as const;

export interface RecommendOptions {
  /** Defaults to OPENROUTER_INFRA_KEY (the user's OpenRouter key). */
  apiKey?: string;
  /** Defaults to OPENROUTER_RECOMMEND_MODEL, then RECOMMEND_PROFILE.model. */
  model?: string;
  fallbackModels?: string[];
  baseUrl?: string;
  fetchImpl?: OpenRouterFetch;
  requestTimeoutMs?: number;
}

const PROMPT = (goal: string): string =>
  `You are a procurement advisor for developers. A developer wants to BUY a SaaS or MCP tool to accomplish a goal, then have an automated agent purchase its plan.\n` +
  `Goal: ${goal}\n\n` +
  `Recommend the SINGLE best-fit, widely-used, reputable tool. Prefer tools that ship an official MCP server or a clean API. ` +
  `Give its CANONICAL pricing or checkout URL (the public pricing page), e.g. https://resend.com/pricing — a real, current https URL, no tracking params, no guesses at deep checkout links.\n` +
  `In plan_hint, name the plan tier that best fits the goal, e.g. "Pro" or "Pro (~$20/month)" — a short plan name, optionally with rough price/billing; use "" if unsure.\n\n` +
  `Return ONLY minified JSON, no prose, no markdown fences:\n` +
  `{"tool_name":"","vendor":"","category":"","why":"<=20 words","checkout_url":"https://...","plan_hint":"","has_mcp":true,"alternatives":[{"tool_name":"","why":"<=12 words"},{"tool_name":"","why":"<=12 words"}]}`;

/** Extract the first JSON object from a model reply, tolerating fences/prose around it. */
function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("RECOMMEND_BAD_REPLY: no JSON object");
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("RECOMMEND_BAD_REPLY: invalid JSON");
  }
}

function normalizeUrl(raw: unknown): { url: string; warning?: string } {
  const s = typeof raw === "string" ? raw.trim() : "";
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    return { url: u.toString() };
  } catch {
    return { url: s, warning: "The model didn't return a usable https checkout URL — confirm the vendor's pricing page before buying." };
  }
}

function coerce(obj: Record<string, unknown>, modelUsed: string | undefined): ToolRecommendation {
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  const tool = str(obj["tool_name"], "unknown");
  const { url, warning } = normalizeUrl(obj["checkout_url"]);
  // A short name only (aisle__shop caps plan_hint at 200 chars); anything else is dropped.
  const planHint = str(obj["plan_hint"]).slice(0, 200);
  const altRaw = Array.isArray(obj["alternatives"]) ? obj["alternatives"] : [];
  const alternatives: ToolAlternative[] = altRaw
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
    .slice(0, 4)
    .map((a) => ({ tool_name: str(a["tool_name"], "?"), why: str(a["why"]) }))
    .filter((a) => a.tool_name !== "?");
  return {
    tool_name: tool,
    vendor: str(obj["vendor"], tool),
    category: str(obj["category"]),
    why: str(obj["why"]),
    checkout_url: url,
    ...(planHint ? { plan_hint: planHint } : {}),
    has_mcp: obj["has_mcp"] === true,
    alternatives,
    ...(modelUsed ? { model_used: modelUsed } : {}),
    ...(warning ? { url_warning: warning } : {}),
  };
}

/**
 * Ask an OpenRouter model to recommend the best-fit tool for a goal and return its
 * checkout URL. Tries the primary model then fallbacks (a stale slug or a 402 on the
 * primary advances the chain), so a rate-limited or spent key still resolves.
 */
export async function recommendTool(goal: string, options: RecommendOptions = {}): Promise<ToolRecommendation> {
  const g = goal.trim();
  if (!g) throw new Error("RECOMMEND_EMPTY_GOAL");
  const apiKey = options.apiKey ?? process.env["OPENROUTER_INFRA_KEY"];
  if (!apiKey) throw new Error("OPENROUTER_INFRA_KEY is required to recommend a tool (set your OpenRouter key).");
  const model = options.model ?? process.env["OPENROUTER_RECOMMEND_MODEL"] ?? RECOMMEND_PROFILE.model;
  const fallbackModels = options.fallbackModels ?? [...RECOMMEND_PROFILE.models];
  const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  const doFetch: OpenRouterFetch = options.fetchImpl ?? (globalThis.fetch as unknown as OpenRouterFetch);

  const modelChain = [model, ...fallbackModels];
  let lastError: unknown;
  for (let attempt = 0; attempt < modelChain.length; attempt++) {
    const activeModel = modelChain[attempt]!;
    const routeFallbacks = modelChain.slice(attempt + 1);
    const payload: Record<string, unknown> = {
      model: activeModel,
      max_tokens: 1024,
      reasoning: { exclude: true },
      messages: [{ role: "user", content: PROMPT(g) }],
    };
    if (routeFallbacks.length > 0) payload["models"] = routeFallbacks;

    let resp: Awaited<ReturnType<OpenRouterFetch>>;
    try {
      resp = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://aisle.dev",
          "X-OpenRouter-Title": "Aisle",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? OPENROUTER_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = new Error(`RECOMMEND_REQUEST_FAILED: ${String(err)}`);
      continue;
    }
    if (!resp.ok) {
      lastError = new Error(`RECOMMEND_HTTP_${resp.status}`);
      continue;
    }
    let content: string | undefined;
    let modelUsed: string | undefined;
    try {
      const body = JSON.parse(await resp.text()) as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
      const c = body.choices?.[0]?.message?.content;
      content = typeof c === "string" ? c : undefined;
      modelUsed = typeof body.model === "string" ? body.model : undefined;
    } catch {
      content = undefined;
    }
    try {
      return coerce(extractJson(content ?? ""), modelUsed);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("RECOMMEND_FAILED");
}
