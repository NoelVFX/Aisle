/**
 * Replay of a released Steel session (steel.md §16.1).
 *
 * Steel serves a headful recording as an HLS playlist at
 * `GET /v1/sessions/{id}/hls`, behind the `steel-api-key` header. The segments
 * it lists are presigned storage URLs that need no key. So the gateway proxies
 * only the playlist: the key stays server-side, and the player fetches segments
 * directly.
 *
 * A just-released session has no recording yet; that is `processing`, not an
 * error.
 */

export type ReplayPlaylist =
  | { status: "ready"; body: string }
  | { status: "processing" }
  | { status: "unavailable"; reason: string };

export interface ReplaySource {
  playlist(sessionId: string): Promise<ReplayPlaylist>;
}

export type ReplayFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SteelReplayOptions {
  apiKey: string;
  apiBase?: string;
  fetchImpl?: ReplayFetch;
  /** Presigned segment URLs expire; don't serve a cached playlist for long. Default 60s. */
  cacheMs?: number;
  now?: () => number;
}

export function steelReplaySource(options: SteelReplayOptions): ReplaySource {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as ReplayFetch);
  const apiBase = (options.apiBase ?? "https://api.steel.dev").replace(/\/+$/, "");
  const cacheMs = options.cacheMs ?? 60_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; body: string }>();

  return {
    async playlist(sessionId) {
      if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return { status: "unavailable", reason: "BAD_SESSION_ID" };
      const hit = cache.get(sessionId);
      if (hit && now() - hit.at < cacheMs) return { status: "ready", body: hit.body };

      let res: Awaited<ReturnType<ReplayFetch>>;
      try {
        res = await fetchImpl(`${apiBase}/v1/sessions/${sessionId}/hls`, { headers: { "steel-api-key": options.apiKey } });
      } catch {
        return { status: "processing" };
      }
      if (res.status === 401 || res.status === 403) return { status: "unavailable", reason: "STEEL_AUTH" };
      if (!res.ok) {
        return res.status === 404 || res.status === 409 || res.status === 425 || res.status >= 500
          ? { status: "processing" }
          : { status: "unavailable", reason: `STEEL_${res.status}` };
      }
      const body = await res.text();
      if (!body.startsWith("#EXTM3U") || !body.includes("#EXTINF")) return { status: "processing" };
      cache.set(sessionId, { at: now(), body });
      return { status: "ready", body };
    },
  };
}
