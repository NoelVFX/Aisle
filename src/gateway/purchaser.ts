/**
 * Slow lane for an approved gateway recovery, in a local Playwright browser.
 *
 *   Local persistent-profile session for (user, vendor) → liveness probe →
 *   balance read → offers (tier 1) → stage via recorded steps (tier 2) or the AX
 *   picker (tier 3, promoted to tier 2) → Gate 1 → deterministic submit (or
 *   withheld for an unapproved real-money vendor) → Gate 2.
 *
 * The browser runs on this machine (a real Chromium window the user can watch and,
 * if a login is needed, take over directly). The vision computer-use agent only
 * helps discovery/staging when both deterministic tiers fail. No model ever clicks
 * submit.
 */

import { join } from "node:path";
import { runSlowLane, type SlowLaneEvent } from "../slow-lane/executor.js";
import { LocalBrowserProvider, type LocalProviderOptions } from "../slow-lane/local-provider.js";
import { FileProfileStore } from "../slow-lane/profiles.js";
import { LadderVendorAdapter } from "../slow-lane/adapters/ladder-adapter.js";
import { FileAdapterRegistry } from "../slow-lane/adapters/recorded-adapter.js";
import { createOpenRouterPicker } from "../slow-lane/resolver/picker.js";
import { createOpenRouterComputerUseAgent } from "../slow-lane/computer-use.js";
import { SubmitWithheldError, TakeoverRequiredError } from "../errors.js";
import { purchaseKeyFor, type IdempotencyStore } from "../fast-lane/idempotency.js";
import { resolveRequirement } from "../core/outcome.js";
import type { SteelLive, SteelPurchaser } from "./recovery.js";

/** How long a scoped takeover (sign-in, 3-D Secure) may take in the local window. */
export const TAKEOVER_WAIT_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SlowLanePurchaserOptions {
  /** `.aisle` — profiles, recorded adapters, resolver recordings. */
  stateDir: string;
  /** Local browser options (profilesDir is derived from stateDir when omitted). */
  browser?: Partial<LocalProviderOptions>;
  /** Shared across jobs so "did we buy?" survives between recoveries in one gateway. */
  store: IdempotencyStore;
  mandateSecret?: string;
  env?: NodeJS.ProcessEnv;
  /** Vendor balance APIs (Gate 2 reads these instead of the page when present). */
  balanceReaders?: Readonly<Record<string, () => Promise<number | undefined>>>;
}

export function createSlowLanePurchaser(options: SlowLanePurchaserOptions): SteelPurchaser {
  const env = options.env ?? process.env;
  const profilesDir = join(options.stateDir, "profiles");

  return {
    async purchase({ job, upstream, realMoneyAllowed, emit, onLive }) {
      const cfg = upstream.purchase;
      if (!cfg) throw new Error(`Upstream '${job.namespace}' has no purchase config.`);
      if (!job.quote || !job.mandate) throw new Error("Recovery has no approved mandate.");

      // A real Chromium on this machine. Headless by default for speed; set
      // AISLE_HEADED=1 to watch. (Log in ahead of time with `npm run login`.)
      const provider = new LocalBrowserProvider({
        profilesDir,
        headed: env["AISLE_HEADED"] === "1",
        ...(env["AISLE_BROWSER_CHANNEL"] ? { channel: env["AISLE_BROWSER_CHANNEL"] } : {}),
        ...options.browser,
      });

      const infraKey = env["OPENROUTER_INFRA_KEY"];
      const replay = env["REPLAY_RESOLVER"] === "1";

      const picker =
        infraKey || replay
          ? createOpenRouterPicker({
              ...(infraKey ? { apiKey: infraKey } : {}),
              replay,
              recordingsFile: join(options.stateDir, "resolver-recordings.json"),
            })
          : undefined;

      const balanceReader = options.balanceReaders?.[job.namespace];
      const adapter = new LadderVendorAdapter({
        provider: job.namespace,
        billingOrigin: upstream.billingOrigin,
        ...(cfg.pricingPath ? { pricingPath: cfg.pricingPath } : {}),
        ...(cfg.accountPath ? { accountPath: cfg.accountPath } : {}),
        ...(cfg.accountPaths ? { accountPaths: [...cfg.accountPaths] } : {}),
        ...(cfg.balanceSelectors ? { balanceSelectors: [...cfg.balanceSelectors] } : {}),
        ...(cfg.balanceRevealSelector ? { balanceRevealSelector: cfg.balanceRevealSelector } : {}),
        ...(cfg.menuHoverSelector ? { menuHoverSelector: cfg.menuHoverSelector } : {}),
        ...(cfg.dismissSelectors ? { dismissSelectors: [...cfg.dismissSelectors] } : {}),
        ...(cfg.offerEntryPath ? { offerEntryPath: cfg.offerEntryPath } : {}),
        ...(cfg.offerRevealSelectors ? { offerRevealSelectors: [...cfg.offerRevealSelectors] } : {}),
        ...(cfg.excludeControlsPattern ? { excludeControlsRegex: new RegExp(cfg.excludeControlsPattern, "i") } : {}),
        ...(cfg.requireLabelledTotal ? { requireLabelledTotal: true } : {}),
        ...(cfg.selectOfferByText ? { selectOfferByText: true } : {}),
        ...(cfg.loggedInSelector ? { loggedInSelector: cfg.loggedInSelector } : {}),
        ...(cfg.loggedOutSelector ? { loggedOutSelector: cfg.loggedOutSelector } : {}),
        ...(cfg.loginWallPattern ? { loginWallPattern: new RegExp(cfg.loginWallPattern, "i") } : {}),
        ...(cfg.offersFrom === "catalogue" ? { catalogueOffers: [...upstream.offers] } : {}),
        ...(cfg.paymentOrigins ? { paymentOrigins: [...cfg.paymentOrigins] } : {}),
        ...(cfg.stripeTestCard ? { stripeTestCard: true } : {}),
        ...(balanceReader ? { balanceReader } : {}),
        registry: new FileAdapterRegistry(join(options.stateDir, "adapters")),
        ...(picker ? { picker } : {}),
        onEvent: (type, detail) => emit(type, detail),
      });

      const agent = infraKey ? createOpenRouterComputerUseAgent({ apiKey: infraKey }) : undefined;

      try {
        const result = await runSlowLane(
          { checkpoint: job.checkpoint, quote: job.quote, mandate: job.mandate },
          {
            provider,
            adapter,
            profiles: new FileProfileStore(profilesDir),
            ...(agent ? { agent } : {}),
            onTakeover: async (ctx) => {
              // The browser is local and headed: the user signs in directly in the window.
              emit("TAKEOVER_REQUIRED", { reason: ctx.reason, maxSeconds: TAKEOVER_WAIT_MS / 1000 });
              const deadline = Date.now() + TAKEOVER_WAIT_MS;
              while (!(await ctx.cleared().catch(() => false))) {
                if (Date.now() > deadline) {
                  throw new TakeoverRequiredError(`${ctx.reason} was not cleared within ${TAKEOVER_WAIT_MS / 60_000} minutes.`);
                }
                await sleep(2000);
              }
              emit("TAKEOVER_RESOLVED", { reason: ctx.reason });
            },
            store: options.store,
            stopBeforeSubmit: !realMoneyAllowed,
            ...(options.mandateSecret ? { mandateSecret: options.mandateSecret } : {}),
            emit: (event: SlowLaneEvent) => {
              const { type, ...rest } = event;
              emit(type, rest as Record<string, unknown>);
              if (event.type === "STEEL_SESSION_CREATED") {
                // Local window — no cloud viewer URL; the user watches it directly.
                const live: SteelLive = { sessionId: event.sessionId, debugUrl: undefined, viewerUrl: undefined, interactive: false };
                onLive(live);
              }
            },
          },
        );
        // Release this recovery's record so the next wall of the same size in this
        // session can buy again instead of being mistaken for a retry.
        const request = { checkpoint: job.checkpoint, quote: job.quote, mandate: job.mandate };
        await options.store.forget(purchaseKeyFor(job.mandate, resolveRequirement(request)));
        return { outcome: "verified", result };
      } catch (err) {
        if (err instanceof SubmitWithheldError) return { outcome: "withheld", staged: err.staged };
        throw err;
      }
    },
  };
}
