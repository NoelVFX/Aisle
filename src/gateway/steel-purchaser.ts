/**
 * Slow lane for an approved gateway recovery, in a real Steel browser
 * (aisle-pipeline.md §15, §17, §18; steel.md §20).
 *
 *   Steel session on the (user, vendor) profile → liveness probe → balance read →
 *   offers (tier 1) → stage via recorded steps (tier 2) or the AX picker (tier 3,
 *   promoted to tier 2) → Gate 1 → deterministic submit (or withheld for an
 *   unapproved real-money vendor) → Gate 2 → profile READY
 *
 * The vision computer-use agent only helps discovery/staging when both tiers
 * fail. No model ever clicks submit.
 */

import { join } from "node:path";
import Steel from "steel-sdk";
import { runSlowLane, type SlowLaneEvent } from "../slow-lane/executor.js";
import { SteelBrowserProvider, type SteelProviderOptions } from "../slow-lane/steel-provider.js";
import { FileProfileStore } from "../slow-lane/profiles.js";
import { LadderVendorAdapter } from "../slow-lane/adapters/ladder-adapter.js";
import { FileAdapterRegistry } from "../slow-lane/adapters/recorded-adapter.js";
import { createOpenRouterPicker } from "../slow-lane/resolver/picker.js";
import { createOpenRouterComputerUseAgent } from "../slow-lane/computer-use.js";
import { SubmitWithheldError } from "../errors.js";
import { purchaseKeyFor, type IdempotencyStore } from "../fast-lane/idempotency.js";
import { resolveRequirement } from "../core/outcome.js";
import type { SteelPurchaser } from "./recovery.js";

export interface SteelPurchaserOptions {
  /** `.aisle` — profiles, recorded adapters, resolver recordings. */
  stateDir: string;
  steelProvider?: SteelProviderOptions;
  /** Shared across jobs so "did we buy?" survives between recoveries in one gateway. */
  store: IdempotencyStore;
  mandateSecret?: string;
  env?: NodeJS.ProcessEnv;
}

export function createSteelPurchaser(options: SteelPurchaserOptions): SteelPurchaser {
  const env = options.env ?? process.env;

  return {
    async purchase({ job, upstream, realMoneyAllowed, emit, onLive }) {
      const cfg = upstream.purchase;
      if (!cfg) throw new Error(`Upstream '${job.namespace}' has no purchase config.`);
      if (!job.quote || !job.mandate) throw new Error("Recovery has no approved mandate.");

      const provider = new SteelBrowserProvider(options.steelProvider);
      const client = new Steel({ steelAPIKey: options.steelProvider?.apiKey ?? env["STEEL_API_KEY"] ?? "" });
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

      const adapter = new LadderVendorAdapter({
        provider: job.namespace,
        billingOrigin: upstream.billingOrigin,
        ...(cfg.pricingPath ? { pricingPath: cfg.pricingPath } : {}),
        ...(cfg.accountPath ? { accountPath: cfg.accountPath } : {}),
        ...(cfg.loggedInSelector ? { loggedInSelector: cfg.loggedInSelector } : {}),
        ...(cfg.loginWallPattern ? { loginWallPattern: new RegExp(cfg.loginWallPattern, "i") } : {}),
        ...(cfg.offersFrom === "catalogue" ? { catalogueOffers: [...upstream.offers] } : {}),
        registry: new FileAdapterRegistry(join(options.stateDir, "adapters")),
        ...(picker ? { picker } : {}),
        onEvent: (type, detail) => emit(type, detail),
      });

      const agent = infraKey ? createOpenRouterComputerUseAgent({ apiKey: infraKey }) : undefined;

      // Web path (web-path.md §2.2): capture cookies + localStorage from the user's
      // LIVE browsing session. The worker starts from them, isolated, and persists nothing.
      const sessionContext = job.workerContextFrom ? await client.sessions.context(job.workerContextFrom) : undefined;
      if (sessionContext) emit("WORKER_CONTEXT_CAPTURED", { fromBrowsingSession: true });

      try {
        const result = await runSlowLane(
          { checkpoint: job.checkpoint, quote: job.quote, mandate: job.mandate },
          {
            provider,
            adapter,
            ...(sessionContext ? { sessionContext } : { profiles: new FileProfileStore(join(options.stateDir, "profiles")) }),
            ...(agent ? { agent } : {}),
            store: options.store,
            stopBeforeSubmit: !realMoneyAllowed,
            ...(options.mandateSecret ? { mandateSecret: options.mandateSecret } : {}),
            emit: (event: SlowLaneEvent) => {
              const { type, ...rest } = event;
              emit(type, rest as Record<string, unknown>);
              if (event.type === "STEEL_SESSION_CREATED") {
                void client.sessions
                  .retrieve(event.sessionId)
                  .then((d) => onLive({ sessionId: event.sessionId, debugUrl: d.debugUrl, viewerUrl: event.sessionViewerUrl }))
                  .catch(() => onLive({ sessionId: event.sessionId, debugUrl: undefined, viewerUrl: event.sessionViewerUrl }));
              }
            },
          },
        );
        // This recovery is finished and verified. Release its record so the next
        // wall of the same size in this session can buy again instead of being
        // mistaken for a retry of this purchase.
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
