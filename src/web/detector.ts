/**
 * The wire trigger (web-path.md §3). Pure decision logic for one network
 * response observed in the user's browsing session, so it is testable without
 * a browser. The CDP wiring lives in browsing.ts.
 *
 * Same classifier as the MCP path — never forked. No DOM scraping.
 */

import { classifyFailure } from "../classifier.js";
import type { Blocker } from "../types.js";
import type { Enrollment } from "./enrollments.js";

export interface WireResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  /** Body, or undefined when the browser already evicted it. */
  getBody(): Promise<string | undefined>;
}

export interface WireDeps {
  lookupEnrollment(origin: string): Enrollment | undefined;
  /** Toast only. Never a quote. */
  suggestEnrollment(origin: string, status: number): void;
  openRecovery(input: { enrollment: Enrollment; blocker: Blocker; url: string }): Promise<void>;
}

export type WireDecision = "ignored" | "rate_limited" | "suggested" | "not_a_wall" | "recovery";

const WALL_STATUSES = new Set([402, 403, 429]);

const parse = (text: string | undefined): unknown => {
  if (text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export async function handleWireResponse(response: WireResponse, deps: WireDeps): Promise<WireDecision> {
  if (!WALL_STATUSES.has(response.status)) return "ignored";

  const headers = Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k.toLowerCase(), v]));
  // A rate limit is not a billing wall. Buying credits would not fix it.
  const retryAfter = Number(headers["retry-after"]);
  if (response.status === 429 && Number.isFinite(retryAfter) && retryAfter < 60) return "rate_limited";

  let origin: string;
  try {
    origin = new URL(response.url).origin;
  } catch {
    return "ignored";
  }

  // ENROLLMENT GATE — the whole security story for this path (§4).
  const enrollment = deps.lookupEnrollment(origin);
  if (!enrollment) {
    deps.suggestEnrollment(origin, response.status);
    return "suggested";
  }

  const text = await response.getBody().catch(() => undefined);
  const body = parse(text);
  const inner =
    body !== null && typeof body === "object" && typeof (body as { error?: unknown }).error === "object" && (body as { error?: unknown }).error !== null
      ? (body as { error: unknown }).error
      : body;

  const classified = classifyFailure(
    { status: response.status, headers, ...(inner === undefined ? {} : { error: inner }) },
    { provider: enrollment.provider, bodyAvailable: text !== undefined },
  );
  if (!classified.recoverable) return "not_a_wall";

  // The trigger says WHICH enrollment matched. It never defines where money goes.
  await deps.openRecovery({ enrollment, blocker: classified.blocker, url: response.url });
  return "recovery";
}
