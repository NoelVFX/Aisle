/**
 * The one projection of a recovery that every watch surface renders
 * (aisle-pipeline.md §12, §22): the cloud page at /r/{id} and the in-app widget
 * GUI agents embed. Both get it from GET /r/{id}/events; neither talks to the
 * browser.
 *
 * Only mandate-visible fields leave this module. Never the mandate signature or
 * nonce, a profileId, the access token, or a raw Steel debug URL. The live
 * viewer is `viewer.embed_url`, whose `interactive` flag is decided here, from
 * server state: true only while a takeover is pending.
 */

import type { JobStatus, RecoveryJob, TimelineEvent } from "./recovery.js";
import { linkExpiresAt } from "./watch-access.js";

export type WatchPhase =
  | "connecting"
  | "live"
  | "awaiting_approval"
  | "takeover_requested"
  | "completed"
  | "refused"
  | "failed";

export type WatchViewer =
  | { mode: "none" }
  | { mode: "live"; session_id: string; embed_url: string | null; interactive: boolean; dashboard_url: string | null }
  | { mode: "replay"; session_id: string; replay_path: string; dashboard_url: string | null };

export interface WatchTimelineEvent {
  seq: number;
  at: string;
  type: string;
  detail: Record<string, unknown>;
}

export interface WatchView {
  recovery_id: string;
  phase: WatchPhase;
  status: JobStatus;
  lane: "slow" | "viewing" | null;
  blocked_tool: string;
  blocker: string;
  billing_origin: string;
  quote: { reason: string; product: string; units: number; price: number; currency: string } | null;
  /** Every field here is a field of the signed mandate. No signature, no nonce. */
  mandate: {
    mandate_id: string;
    product: string;
    units: number;
    cap: number;
    currency: string;
    billing: string;
    auto_renew: boolean;
    billing_origin: string;
    expires_at: string;
  } | null;
  remaining: { task: number; day: number } | null;
  viewer: WatchViewer;
  takeover: { reason: string; requested_at: string; deadline: string } | null;
  outcome: { headline: string; detail: string | null };
  staged: { line_item: string; amount: number; currency: string; billing_period: string; auto_renew: boolean } | null;
  /** The viewing lane holds its session open until the user ends it. */
  can_release: boolean;
  event_count: number;
  last_event_at: string | null;
  created_at: string;
  finished_at: string | null;
  link_expires_at: string | null;
}

export interface ProjectOptions {
  linkTtlMs: number;
  /** Operator opted into an interactive viewer outside takeovers (AISLE_STEEL_INTERACTIVE=1). */
  viewerInteractive?: boolean;
}

export function phaseOf(job: Pick<RecoveryJob, "status" | "takeover" | "live" | "replay">): WatchPhase {
  switch (job.status) {
    case "awaiting_approval":
      return "awaiting_approval";
    case "running":
      // Once a session exists the run stays "live" until it finishes, even after release.
      return job.takeover ? "takeover_requested" : job.live || job.replay ? "live" : "connecting";
    case "resolved":
    case "dry_run_complete":
    case "staged_not_submitted":
      return "completed";
    case "refused":
    case "rejected":
      return "refused";
    case "failed":
      return "failed";
  }
}

/** The Steel live player with the interaction flag this state allows. Headful sessions honour `interactive`. */
export function embedUrl(debugUrl: string, interactive: boolean): string {
  const u = new URL(debugUrl);
  u.searchParams.set("interactive", String(interactive));
  u.searchParams.set("showControls", "false");
  return u.toString();
}

const SECRET_KEY = /signature|nonce|token|secret|password|passcode|api[-_]?key|profile[-_]?id|debug[-_]?url|websocket/i;

function scrub(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.replace(/([?&]t=)[^&\s"]+/g, "$1…");
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!SECRET_KEY.test(k)) out[k] = scrub(v, depth + 1);
  }
  return out;
}

/** Timeline detail as the page may show it. */
export function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return scrub(detail, 0) as Record<string, unknown>;
}

export function projectEvent(seq: number, event: TimelineEvent): WatchTimelineEvent {
  return { seq, at: event.at, type: event.type, detail: redactDetail(event.detail) };
}

function viewerOf(job: RecoveryJob, options: ProjectOptions): WatchViewer {
  if (job.live) {
    const interactive = job.takeover !== undefined || options.viewerInteractive === true;
    return {
      mode: "live",
      session_id: job.live.sessionId,
      embed_url: job.live.debugUrl ? embedUrl(job.live.debugUrl, interactive) : null,
      interactive,
      dashboard_url: job.live.viewerUrl ?? null,
    };
  }
  if (job.replay) {
    return {
      mode: "replay",
      session_id: job.replay.sessionId,
      replay_path: `/r/${job.id}/replay.m3u8`,
      dashboard_url: job.replay.viewerUrl ?? null,
    };
  }
  return { mode: "none" };
}

const money = (n: number, currency = "USD") => `${currency === "USD" ? "$" : ""}${n.toFixed(2)}${currency === "USD" ? "" : ` ${currency}`}`;

function outcomeOf(job: RecoveryJob): WatchView["outcome"] {
  const product = job.quote ? `${job.quote.unitsGranted.toLocaleString("en-US")} units (${job.quote.productId})` : "the quoted package";
  switch (job.status) {
    case "awaiting_approval":
      return { headline: "Waiting for your approval", detail: job.quote?.reason ?? null };
    case "running":
      if (job.takeover) return { headline: "Your turn in the browser", detail: job.takeover.reason };
      if (job.live) return { headline: "Aisle is working in a live browser", detail: `On ${job.checkpoint.origin.billingOrigin}, for ${product}.` };
      return { headline: job.replay ? "Finishing up" : "Starting a browser", detail: `On ${job.checkpoint.origin.billingOrigin}.` };
    case "resolved":
      return job.purchase?.alreadyCovered
        ? { headline: "Already covered", detail: "The balance already covered the call. Nothing was bought." }
        : {
            headline: "Purchase verified",
            detail:
              job.purchase?.balance != null
                ? `The balance now reads ${job.purchase.balance.toLocaleString("en-US")}. The blocked call resumes.`
                : "The entitlement was verified. The blocked call resumes.",
          };
    case "dry_run_complete":
      return { headline: "Billing page opened", detail: "This vendor has no purchase wired, so nothing was bought." };
    case "staged_not_submitted":
      return {
        headline: "Checkout staged, not submitted",
        detail: job.staged
          ? `${job.staged.lineItem} at ${money(job.staged.amount, job.staged.currency)} matched the mandate. Real-money submit isn't enabled for this vendor, so nothing was charged.`
          : "Real-money submit isn't enabled for this vendor, so nothing was charged.",
      };
    case "refused":
      return { headline: "Refused by policy", detail: job.refusal?.message ?? null };
    case "rejected":
      return { headline: "You declined this purchase", detail: "Nothing was bought." };
    case "failed":
      return { headline: "Recovery failed", detail: job.error ?? null };
  }
}

export function projectJob(job: RecoveryJob, options: ProjectOptions): WatchView {
  const m = job.mandate;
  const last = job.events[job.events.length - 1];
  return {
    recovery_id: job.id,
    phase: phaseOf(job),
    status: job.status,
    lane: job.lane ?? null,
    blocked_tool: job.checkpoint.tool,
    blocker: job.checkpoint.blocker.type,
    billing_origin: job.checkpoint.origin.billingOrigin,
    quote: job.quote
      ? { reason: job.quote.reason, product: job.quote.productId, units: job.quote.unitsGranted, price: job.quote.price, currency: job.quote.currency }
      : null,
    mandate: m
      ? {
          mandate_id: m.mandateId,
          product: m.productId,
          units: m.unitsGranted,
          cap: m.maximumAmount,
          currency: m.currency,
          billing: m.billingType,
          auto_renew: m.autoRenew,
          billing_origin: m.billingOrigin,
          expires_at: m.expiresAt,
        }
      : null,
    remaining: job.remaining ?? null,
    viewer: viewerOf(job, options),
    takeover: job.takeover
      ? { reason: job.takeover.reason, requested_at: job.takeover.requestedAt, deadline: job.takeover.deadline }
      : null,
    outcome: outcomeOf(job),
    staged: job.staged
      ? {
          line_item: job.staged.lineItem,
          amount: job.staged.amount,
          currency: job.staged.currency,
          billing_period: job.staged.billingPeriod,
          auto_renew: job.staged.autoRenew,
        }
      : null,
    can_release: job.lane === "viewing" && job.live !== undefined,
    event_count: job.events.length,
    last_event_at: last?.at ?? null,
    created_at: job.createdAt,
    finished_at: job.finishedAt ?? null,
    link_expires_at: linkExpiresAt(job, options.linkTtlMs) ?? null,
  };
}
