/**
 * Fast lane for an approved gateway recovery (aisle-pipeline.md §13 route 1, §14).
 *
 *   connect to the vendor's MCP endpoint (URL from upstreams.json) → detect
 *   purchase + balance tools → guards → balance check → purchase → verify by
 *   balance delta → release the finished record
 *
 * No viable tools, or an endpoint that can't be reached before anything was
 * bought, returns `no_fast_lane` so the router uses the Steel browser. Anything
 * after a purchase call is never retried in the other lane.
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { runFastLane, type FastLaneEvent } from "../fast-lane/executor.js";
import { purchaseKeyFor, type IdempotencyStore } from "../fast-lane/idempotency.js";
import { resolveRequirement } from "../core/outcome.js";
import { NoFastLaneError } from "../errors.js";
import { connectMcpWebMcpSession, type McpWebMcpSessionOptions } from "../webmcp/mcp-http-session.js";
import type { WebMcpSession } from "../webmcp/session.js";
import type { FastPurchaser } from "./recovery.js";

export interface FastPurchaserOptions {
  /** Shared with the slow lane so "did we buy?" is one answer. */
  store: IdempotencyStore;
  mandateSecret?: string;
  /** Account-scoped headers for a vendor's MCP endpoint (e.g. a bearer token env). */
  headersFor?: (namespace: string) => Record<string, string> | undefined;
  /** Injectable for tests. */
  connect?: (options: McpWebMcpSessionOptions) => Promise<WebMcpSession & { close(): Promise<void> }>;
}

export function createFastPurchaser(options: FastPurchaserOptions): FastPurchaser {
  const connect = options.connect ?? connectMcpWebMcpSession;

  return {
    async purchase({ job, upstream, emit }) {
      const url = upstream.purchase?.mcpUrl;
      if (!url) return { outcome: "no_fast_lane", reason: "No MCP purchase endpoint configured." };
      if (!job.quote || !job.mandate) throw new Error("Recovery has no approved mandate.");

      let session: (WebMcpSession & { close(): Promise<void> }) | undefined;
      try {
        const headers = options.headersFor?.(job.namespace);
        const dial = upstream.purchase?.mcpDialUrl;
        // The session's origin (and so the origin lock) always comes from `url`.
        // A loopback dial address only changes where the bytes go.
        const transport = dial
          ? (new StreamableHTTPClientTransport(new URL(dial), {
              fetch: (u, init) => fetch(u, { ...init, redirect: "error" }),
              ...(headers ? { requestInit: { headers, redirect: "error" } } : {}),
            }) as Transport)
          : undefined;
        session = await connect({ provider: job.namespace, url, ...(headers ? { headers } : {}), ...(transport ? { transport } : {}) });
      } catch (err) {
        // Nothing was attempted, so falling back to the browser is safe.
        return { outcome: "no_fast_lane", reason: `Could not reach the vendor's MCP endpoint: ${err instanceof Error ? err.message : String(err)}` };
      }

      const request = { checkpoint: job.checkpoint, quote: job.quote, mandate: job.mandate };
      try {
        const result = await runFastLane(request, {
          session,
          store: options.store,
          ...(options.mandateSecret ? { mandateSecret: options.mandateSecret } : {}),
          emit: (event: FastLaneEvent) => {
            const { type, ...rest } = event;
            emit(type, rest as Record<string, unknown>);
          },
        });
        // Finished and verified: release the record so a later shortfall can buy again.
        await options.store.forget(purchaseKeyFor(job.mandate, resolveRequirement(request)));
        return { outcome: "verified", result };
      } catch (err) {
        if (err instanceof NoFastLaneError) return { outcome: "no_fast_lane", reason: err.message };
        throw err;
      } finally {
        await session.close().catch(() => {});
      }
    },
  };
}
