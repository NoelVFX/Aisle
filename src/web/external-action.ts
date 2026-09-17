/**
 * Prompt-driven external web actions.
 *
 * A link in a prompt is not trusted as a payment origin. It is only used to
 * select a configured upstream; money and recovery origins still come from
 * upstreams.json. The action itself runs in a short-lived Steel worker with
 * computer-use, and billing walls are handed to the existing coordinator.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { classifyFailure } from "../classifier.js";
import type { Blocker, PurchaseOffer } from "../types.js";
import type { PurchaseConfig, UpstreamEntry, Upstreams } from "../gateway/upstreams.js";
import type { RecoveryCoordinator, RecoveryJob } from "../gateway/recovery.js";
import { profileDirFor, type FileProfileStore } from "../slow-lane/profiles.js";
import type { LoginManager } from "./login-manager.js";
import { ACTION_TIMEOUT_MS, DEFAULT_DIMENSIONS, NAVIGATION_TIMEOUT_MS, PlaywrightControl, PlaywrightPage } from "../slow-lane/playwright-page.js";
import { offersFromJsonLd } from "../slow-lane/adapters/ladder-adapter.js";
import { parseOffersFromText } from "../slow-lane/adapters/generic-vendor-adapter.js";
import { createOpenRouterComputerUseAgent, type ComputerUseAgent } from "../slow-lane/computer-use.js";

/** Payment processors an ad-hoc checkout may hop to. Origin-locked to these plus the vendor origin. */
const KNOWN_PAYMENT_ORIGINS = [
  "https://checkout.stripe.com",
  "https://buy.stripe.com",
  "https://checkout.paddle.com",
  "https://pay.paddle.com",
  "https://www.paypal.com",
  "https://checkout.lemonsqueezy.com",
];

/**
 * Build a vendor config on the fly from a URL — the zero-integration path. No
 * merchant setup: the origin the user pointed at becomes the LOCKED billing
 * origin, offers are discovered by browsing, and everything else uses generic
 * defaults. `realMoney: false` means it submits after the ONE human approval
 * (test-mode Stripe checkouts pay with card 4242 for free; a live checkout uses
 * the saved card — the approval is the gate). Set AISLE_ADHOC_WITHHOLD=1 to stage
 * without submitting for un-allowlisted ad-hoc vendors instead.
 */
export function adHocUpstream(url: string, env: NodeJS.ProcessEnv = process.env): { provider: string; upstream: UpstreamEntry } {
  const parsed = new URL(url);
  const origin = parsed.origin;
  const purchase: PurchaseConfig = {
    mode: "slow-lane",
    realMoney: env["AISLE_ADHOC_WITHHOLD"] === "1",
    pricingPath: parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/",
    accountPath: parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/",
    loginWallPattern: "^/(login|sign-?in|auth)",
    paymentOrigins: KNOWN_PAYMENT_ORIGINS,
    stripeTestCard: true, // guarded to cs_test_ Checkout Sessions only; live uses the saved card
    selectOfferByText: true,
    requireLabelledTotal: true,
    loggedOutSelector: "input[type='password'],a[href*='login' i],a[href*='signin' i],a[href*='sign-in' i],button:has-text('Sign in'),button:has-text('Log in')",
    dismissSelectors: ["button:has-text('Dismiss')", "button:has-text('Accept')", "[aria-label*='close' i]", "[role='dialog'] button:has(svg)"],
  };
  const upstream: UpstreamEntry = {
    description: `Ad-hoc vendor synthesized from ${origin} (no merchant integration).`,
    canonicalOrigin: origin,
    billingOrigin: origin,
    billingUrl: url,
    resource: "credits",
    offers: [], // discovered at runtime by browsing the pricing/billing page
    purchase,
  };
  return { provider: parsed.hostname, upstream };
}

export interface ExternalActionRequest {
  taskId: string;
  prompt: string;
  url?: string;
  maxSteps?: number;
}

export interface ExternalActionTarget {
  url: string;
  provider: string;
  upstream: UpstreamEntry;
}

export type ExternalActionAttempt =
  | { kind: "completed"; note: string; finalUrl: string; viewerUrl?: string }
  | { kind: "billing_wall"; blocker: Blocker; finalUrl: string; viewerUrl?: string };

export interface ExternalActionExecutor {
  run(input: ExternalActionRequest & ExternalActionTarget): Promise<ExternalActionAttempt>;
}

export type ExternalActionResult =
  | { status: "COMPLETED"; provider: string; note: string; final_url: string; viewer_url?: string }
  | { status: "LOGIN_REQUIRED"; provider: string; login_url: string; next: string }
  | { status: "AWAITING_APPROVAL"; recovery_id: string; approve_url: string; provider: string; next: string }
  | { status: "RECOVERY_RUNNING"; recovery_id: string; provider: string }
  | { status: "RECOVERY_FAILED"; recovery_id: string; error?: string };

const URL_RE = /https?:\/\/[^\s<>()]+/gi;

/** Extract the first HTTP(S) URL from a prompt, stripping common punctuation. */
export function extractPromptUrl(prompt: string): string | undefined {
  const raw = prompt.match(URL_RE)?.[0];
  if (!raw) return undefined;
  return raw.replace(/[),.;!?]+$/, "");
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const firstLabel = (origin: string): string => {
  try {
    return new URL(origin).hostname.replace(/^www\./, "").split(".")[0] ?? "";
  } catch {
    return "";
  }
};

/** A vendor the user has already established: configured in upstreams.json, or with a saved login profile. */
export interface KnownVendor {
  name: string;
  url: string;
  /** Normalized identifiers to match a spoken name against. */
  keys: string[];
}

/** Hostnames the user has logged in to (a saved profile dir), so a name can resolve to them. */
export function loggedInVendorHosts(profilesDir: string): string[] {
  try {
    return readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_") && e.name.includes("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** The set of vendors a spoken name may resolve to — configured first, then logged-in hosts. */
export function knownVendors(upstreams: Upstreams, profilesDir?: string): KnownVendor[] {
  const out: KnownVendor[] = [];
  const seen = new Set<string>();
  for (const [key, up] of Object.entries(upstreams)) {
    const url = up.billingUrl ?? up.canonicalOrigin ?? up.billingOrigin;
    const keys = [key, firstLabel(up.canonicalOrigin), firstLabel(up.billingOrigin)].map(norm).filter((k) => k.length >= 3);
    out.push({ name: key, url, keys: [...new Set(keys)] });
    try {
      seen.add(new URL(up.canonicalOrigin).hostname);
      seen.add(new URL(up.billingOrigin).hostname);
    } catch { /* ignore */ }
  }
  for (const host of profilesDir ? loggedInVendorHosts(profilesDir) : []) {
    if (seen.has(host)) continue; // already covered by a configured vendor
    out.push({ name: host, url: `https://${host}/`, keys: [...new Set([norm(host), norm(firstLabel(`https://${host}`))].filter((k) => k.length >= 3))] });
  }
  return out;
}

/**
 * Resolve a spoken vendor NAME (no link) to a URL — but ONLY to a vendor the user
 * has already established (configured, or logged in to). A name is never turned
 * into a guessed domain: that would let a typo or a look-alike ("higsfield.co")
 * send money somewhere the user never chose. Returns the single best match, or
 * undefined when nothing matches or the mention is ambiguous.
 */
export function matchVendorByName(prompt: string, upstreams: Upstreams, profilesDir?: string): string | undefined {
  const p = norm(prompt);
  const scored = knownVendors(upstreams, profilesDir)
    .map((v) => ({ v, score: Math.max(0, ...v.keys.filter((k) => p.includes(k)).map((k) => k.length)) }))
    .filter((s) => s.score >= 4)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return undefined;
  // Ambiguous only if two DIFFERENT vendors tie at the top score.
  if (scored.length > 1 && scored[1]!.score === scored[0]!.score && scored[1]!.v.url !== scored[0]!.v.url) return undefined;
  return scored[0]!.v.url;
}

/**
 * Resolve the vendor for a prompt/URL. A CONFIGURED origin uses its tuned config;
 * ANY OTHER https origin is handled with no merchant integration via a synthesized
 * ad-hoc vendor. The origin still comes from the user's own prompt/URL and every
 * purchase is gated by the one human approval, so a prompt link can never redirect
 * money to somewhere the user did not name.
 */
export function resolveExternalTarget(prompt: string, upstreams: Upstreams, explicitUrl?: string, profilesDir?: string): ExternalActionTarget {
  // Prefer an explicit/pasted URL; otherwise resolve a spoken NAME to a vendor the
  // user has already established (configured or logged in). Never guess a domain.
  const url = explicitUrl ?? extractPromptUrl(prompt) ?? matchVendorByName(prompt, upstreams, profilesDir);
  if (!url) {
    const known = knownVendors(upstreams, profilesDir).map((v) => v.name);
    throw new Error(
      `VENDOR_NOT_RECOGNIZED: name a service you've configured or logged in to (or paste its https link).` +
        (known.length ? ` Known: ${known.join(", ")}.` : ""),
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("INVALID_URL: the external service link must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("HTTPS_REQUIRED: external service links must use HTTPS.");
  }
  const found = Object.entries(upstreams).find(([, upstream]) => {
    try {
      return new URL(upstream.canonicalOrigin).origin === parsed.origin || new URL(upstream.billingOrigin).origin === parsed.origin;
    } catch {
      return false;
    }
  });
  if (found) return { url: parsed.toString(), provider: found[0], upstream: found[1] };
  // Zero-integration: any vendor, no config entry required.
  const adhoc = adHocUpstream(parsed.toString());
  return { url: parsed.toString(), provider: adhoc.provider, upstream: adhoc.upstream };
}

/**
 * Browse the vendor's pricing/billing page (in its persistent profile, so a
 * logged-in-only price list is visible) and read its offers via JSON-LD then page
 * text. This is what lets an ad-hoc vendor be quoted before approval.
 */
export async function discoverOffers(billingUrl: string, provider: string, profilesDir: string): Promise<PurchaseOffer[]> {
  const userDataDir = profileDirFor(profilesDir, provider);
  mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: DEFAULT_DIMENSIONS,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const raw = context.pages()[0] ?? (await context.newPage());
    raw.setDefaultTimeout(ACTION_TIMEOUT_MS);
    raw.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const page = new PlaywrightPage(raw);
    await page.goto(billingUrl).catch(() => {});
    await page.settle?.(1500);
    await page.revealByScrolling?.().catch(() => {});
    let offers = offersFromJsonLd(await page.jsonLd().catch(() => []));
    if (offers.length === 0) offers = parseOffersFromText(await page.innerText().catch(() => ""));
    return offers;
  } finally {
    await context.close().catch(() => {});
  }
}

export class ExternalActionManager {
  private readonly actions = new Map<string, ExternalActionRequest & ExternalActionTarget>();

  constructor(
    private readonly deps: {
      upstreams: Upstreams;
      coordinator: RecoveryCoordinator;
      executor: ExternalActionExecutor;
      /** Base dir for persistent vendor profiles; used to discover ad-hoc vendor offers. */
      profilesDir: string;
      /** Optional: enable the friendly first-time sign-in link instead of failing on an auth wall. */
      store?: FileProfileStore;
      loginManager?: LoginManager;
      userId?: string;
      publicUrl?: () => string;
    },
  ) {}

  async execute(request: ExternalActionRequest): Promise<ExternalActionResult> {
    const target = resolveExternalTarget(request.prompt, this.deps.upstreams, request.url, this.deps.profilesDir);

    // First time on this vendor: hand back a one-time sign-in link instead of failing.
    // Once signed in, the profile is remembered and this never fires again.
    if (this.deps.loginManager && this.deps.publicUrl) {
      const loggedIn = await this.deps.loginManager.isLoggedIn(target.provider);
      if (!loggedIn) {
        const pc = target.upstream.purchase;
        this.deps.loginManager.register(target.provider, {
          loginUrl: target.upstream.billingUrl ?? target.url,
          ...(pc?.loggedInSelector ? { loggedInSelector: pc.loggedInSelector } : {}),
          ...(pc?.loggedOutSelector ? { loggedOutSelector: pc.loggedOutSelector } : {}),
          ...(pc?.loginWallPattern ? { loginWallPattern: pc.loginWallPattern } : {}),
        });
        return {
          status: "LOGIN_REQUIRED",
          provider: target.provider,
          login_url: `${this.deps.publicUrl()}/login/${encodeURIComponent(target.provider)}`,
          next: `Give the user this exact link to open in their browser: ${this.deps.publicUrl()}/login/${encodeURIComponent(target.provider)} — they sign in once and the page confirms "You're logged in". Do NOT use your own browser-connect flow. After they confirm, re-run this request.`,
        };
      }
    }

    const isAdHoc = this.deps.upstreams[target.provider] === undefined;
    const full = { ...request, ...target };
    const attempt = await this.deps.executor.run(full);
    if (attempt.kind === "completed") return { status: "COMPLETED", provider: target.provider, note: attempt.note, final_url: attempt.finalUrl, ...(attempt.viewerUrl ? { viewer_url: attempt.viewerUrl } : {}) };

    // No catalogue yet (ad-hoc vendor, or a configured one that discovers prices
    // from the page): browse the pricing page in the vendor's profile so the
    // recovery can quote before approval.
    let upstream = target.upstream;
    let discovered = false;
    if ((upstream.offers?.length ?? 0) === 0) {
      const offers = await discoverOffers(upstream.billingUrl ?? target.url, target.provider, this.deps.profilesDir).catch(() => [] as PurchaseOffer[]);
      if (offers.length === 0) {
        return { status: "RECOVERY_FAILED", recovery_id: "", error: `NO_OFFERS_FOUND: could not read purchasable packs at ${upstream.billingUrl ?? target.url}. Sign in first (npm run login -- ${target.url}) or link the pricing page directly.` };
      }
      upstream = { ...upstream, offers };
      discovered = true;
    }

    const job = await this.deps.coordinator.open({
      taskId: request.taskId,
      toolCallId: randomUUID(),
      namespace: target.provider,
      tool: "aisle__execute_web_action",
      arguments: { prompt: request.prompt, url: target.url, maxSteps: request.maxSteps },
      blocker: attempt.blocker,
      surface: "web",
      ...(isAdHoc || discovered ? { upstream } : {}),
    });
    this.actions.set(job.id, full);
    return this.status(job);
  }

  async wait(recoveryId: string): Promise<ExternalActionResult> {
    let job = this.deps.coordinator.get(recoveryId);
    if (!job) return { status: "RECOVERY_FAILED", recovery_id: recoveryId, error: "UNKNOWN_RECOVERY" };
    if (job.status === "awaiting_approval") return this.status(job);
    if (job.status === "running") {
      job = await this.deps.coordinator.wait(recoveryId, 30_000);
      if (job.status === "running") return { status: "RECOVERY_RUNNING", recovery_id: job.id, provider: job.namespace };
    }
    if (job.status !== "resolved") return { status: "RECOVERY_FAILED", recovery_id: job.id, error: job.error ?? job.status };

    const request = this.actions.get(job.id);
    if (!request) return { status: "RECOVERY_FAILED", recovery_id: job.id, error: "ACTION_CHECKPOINT_MISSING" };
    const attempt = await this.deps.executor.run(request);
    if (attempt.kind === "billing_wall") return { status: "RECOVERY_FAILED", recovery_id: job.id, error: "BILLING_WALL_REMAINED_AFTER_TOP_UP" };
    this.actions.delete(job.id);
    return { status: "COMPLETED", provider: request.provider, note: attempt.note, final_url: attempt.finalUrl, ...(attempt.viewerUrl ? { viewer_url: attempt.viewerUrl } : {}) };
  }

  private status(job: RecoveryJob): ExternalActionResult {
    if (job.status === "awaiting_approval") {
      return {
        status: "AWAITING_APPROVAL",
        recovery_id: job.id,
        approve_url: job.approveUrl,
        provider: job.namespace,
        next: "Approve the top-up, then call aisle__wait_for_external_action with this recovery_id. Do not repeat the original prompt.",
      };
    }
    return { status: "RECOVERY_RUNNING", recovery_id: job.id, provider: job.namespace };
  }
}

/**
 * Local Playwright implementation of the on-demand SaaS path. Runs in the vendor's
 * persistent profile (the login done once via login.ts is reused), so the model can
 * operate the site logged in — but it never pays; a billing wall is handed to the
 * coordinator for approval, exactly like a 402 during a tool call.
 */
export class LocalExternalActionExecutor implements ExternalActionExecutor {
  constructor(
    private readonly options: {
      profilesDir: string;
      agent?: ComputerUseAgent;
      maxSteps?: number;
      headed?: boolean;
    },
  ) {}

  async run(input: ExternalActionRequest & ExternalActionTarget): Promise<ExternalActionAttempt> {
    const agent = this.options.agent ?? createOpenRouterComputerUseAgent();
    const userDataDir = profileDirFor(this.options.profilesDir, input.provider);
    mkdirSync(userDataDir, { recursive: true });
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: this.options.headed === false,
      viewport: DEFAULT_DIMENSIONS,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    let wall: Blocker | undefined;
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      page.on("response", (response) => {
        if (wall || ![402, 403, 429].includes(response.status())) return;
        void (async () => {
          const bodyText = await response.text().catch(() => "");
          let body: unknown = bodyText;
          try { body = JSON.parse(bodyText) as unknown; } catch { /* plain text */ }
          const classified = classifyFailure({ status: response.status(), headers: response.headers(), error: body }, { provider: input.provider, bodyAvailable: true });
          if (classified.recoverable) wall = classified.blocker;
        })();
      });
      await page.goto(input.url, { waitUntil: "domcontentloaded" });
      const control = new PlaywrightControl(page, DEFAULT_DIMENSIONS);
      const outcome = await agent.run(control, input.prompt, { maxSteps: input.maxSteps ?? this.options.maxSteps });
      if (wall) return { kind: "billing_wall", blocker: wall, finalUrl: page.url() };
      return { kind: "completed", note: outcome.note ?? (outcome.success ? "External web action completed." : "External web action stopped before completion."), finalUrl: page.url() };
    } finally {
      await context.close().catch(() => {});
    }
  }
}
