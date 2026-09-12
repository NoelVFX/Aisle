/**
 * Access to a recovery's watch page (/r/{id}).
 *
 * The page shows a real, logged-in browser, so the recovery id alone is not
 * enough: every /r/{id} route needs the job's unguessable access token
 * (`?t=`), and the link expires `linkTtlMs` after the recovery finishes. The
 * token appears only in the watch URL itself: never in an event, the timeline,
 * or `.aisle/events.jsonl`.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RecoveryJob } from "./recovery.js";

/** How long a finished recovery's link keeps working (replay, audit). */
export const DEFAULT_LINK_TTL_MS = 24 * 60 * 60_000;

/** 192 bits, URL-safe. */
export function newAccessToken(): string {
  return randomBytes(24).toString("base64url");
}

export function tokenMatches(job: Pick<RecoveryJob, "accessToken">, presented: string | null | undefined): boolean {
  if (!presented) return false;
  const want = Buffer.from(job.accessToken);
  const got = Buffer.from(presented);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Undefined while the recovery is still open: an open recovery's link never expires. */
export function linkExpiresAt(job: Pick<RecoveryJob, "finishedAt">, ttlMs: number): string | undefined {
  return job.finishedAt === undefined ? undefined : new Date(Date.parse(job.finishedAt) + ttlMs).toISOString();
}

export function linkExpired(job: Pick<RecoveryJob, "finishedAt">, ttlMs: number, now = Date.now()): boolean {
  const at = linkExpiresAt(job, ttlMs);
  return at !== undefined && now >= Date.parse(at);
}

/** The one URL every surface prints: CLI line, tool results, the widget. */
export function watchUrl(baseUrl: string, job: Pick<RecoveryJob, "id" | "accessToken">): string {
  return `${baseUrl.replace(/\/+$/, "")}/r/${job.id}?t=${job.accessToken}`;
}
