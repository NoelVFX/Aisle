/**
 * Vendor balance APIs. The entitlement check before the quote (aisle-pipeline.md §8)
 * and Gate 2 after a purchase (§18) read the vendor's own balance, never a receipt
 * or a page banner. Only vendors with a real balance endpoint and a configured key
 * get a reader; the rest fall back to reading the account page in Steel.
 */

import type { Upstreams } from "./upstreams.js";

export type BalanceReader = () => Promise<number | undefined>;
export type BalanceReaders = Readonly<Record<string, BalanceReader>>;

export type GetJson = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function createBalanceReaders(
  upstreams: Upstreams,
  env: NodeJS.ProcessEnv,
  fetchImpl: GetJson = globalThis.fetch as unknown as GetJson,
): BalanceReaders {
  const readers: Record<string, BalanceReader> = {};
  const get = async (url: string, key: string): Promise<unknown> => {
    try {
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      return res.ok ? await res.json() : undefined;
    } catch {
      return undefined;
    }
  };

  // OpenRouter: remaining USD = total_credits - total_usage, on the user's (drained) key.
  const openRouterKey = upstreams["openrouter"]?.authEnv ? env[upstreams["openrouter"].authEnv] : undefined;
  if (openRouterKey) {
    readers["openrouter"] = async () => {
      const body = (await get("https://openrouter.ai/api/v1/credits", openRouterKey)) as { data?: { total_credits?: unknown; total_usage?: unknown } } | undefined;
      const credits = Number(body?.data?.total_credits);
      const usage = Number(body?.data?.total_usage);
      return Number.isFinite(credits) && Number.isFinite(usage) ? Math.round((credits - usage) * 100) / 100 : undefined;
    };
  }

  // Studio (Stripe test-mode demo vendor): GET /v1/credits → { data: { balance } }.
  const studio = upstreams["studio"];
  const studioKey = studio?.authEnv ? env[studio.authEnv] : undefined;
  const studioBase = studio?.toolUrl?.replace(/\/+$/, "");
  if (studioBase && studioKey) {
    readers["studio"] = async () => {
      const body = (await get(`${studioBase}/v1/credits`, studioKey)) as { data?: { balance?: unknown } } | undefined;
      const balance = Number(body?.data?.balance);
      return Number.isFinite(balance) ? balance : undefined;
    };
  }

  // Higgsfield: GET the configured credits endpoint → tolerant parse of a
  // credits/balance number. Requires HIGGSFIELD_CREDITS_URL + HIGGSFIELD_API_KEY.
  // Without a real balance source, Aisle cannot verify a purchase and will refuse.
  const higgsKey = upstreams["higgsfield"]?.authEnv ? env[upstreams["higgsfield"].authEnv] : undefined;
  const higgsCreditsUrl = env["HIGGSFIELD_CREDITS_URL"];
  if (higgsKey && higgsCreditsUrl) {
    readers["higgsfield"] = async () => pickBalance(await get(higgsCreditsUrl, higgsKey));
  }

  return readers;
}

/** Pull a credit/balance number from common JSON shapes (top-level or under `data`). */
function pickBalance(body: unknown): number | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const o = body as Record<string, unknown>;
  const scope = o["data"] !== null && typeof o["data"] === "object" ? (o["data"] as Record<string, unknown>) : o;
  for (const key of ["credits", "balance", "credits_remaining", "creditsRemaining", "total_credits", "credit_balance", "remaining"]) {
    const v = Number(scope[key]);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}
