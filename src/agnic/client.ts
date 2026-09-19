/**
 * Agnic HTTP client (agentic-commerce Checkout API).
 *
 * The Checkout API lives under `https://api.agnic.ai/api/autofill/*`, plus the
 * passkey-approval poll at `https://api.agnic.ai/api/approvals/{token}`. All calls
 * carry the server-side `X-Agnic-Token`; the token and the vaulted card never
 * appear in client code, tool results, or model prompts.
 *
 * The fetcher is injectable so the whole commerce flow is unit-testable without a
 * live token, and it turns a non-JSON error (a 502 HTML page, a proxy timeout)
 * into a code your branches can read instead of a SyntaxError.
 */

export interface AgnicResponse {
  httpStatus: number;
  data: Record<string, unknown>;
}

export type AgnicFetch = (path: string, init?: { method?: string; body?: unknown }) => Promise<AgnicResponse>;

export interface AgnicClientOptions {
  /** Defaults to https://api.agnic.ai */
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the Agnic client. `path` is the full path after the host, e.g.
 * "/api/autofill/products/search" or "/api/approvals/abc". Never pass a caller-
 * supplied origin: the host is fixed here so a prompt link can't redirect money.
 */
export function createAgnicClient(token: string, options: AgnicClientOptions = {}): AgnicFetch {
  if (!token) throw new Error("AGNIC_TOKEN is required (server-side only; never a VITE_/client var).");
  const base = (options.baseUrl ?? "https://api.agnic.ai").replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? (globalThis.fetch as typeof fetch);

  return async function agnic(path, init = {}): Promise<AgnicResponse> {
    const method = init.method ?? "GET";
    const hasBody = init.body !== undefined;
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          "X-Agnic-Token": token,
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (err) {
      // A lost/failed request is not proof of anything downstream.
      return { httpStatus: 0, data: { error: "request_failed", detail: err instanceof Error ? err.message : String(err) } };
    }
    // Not every failure is JSON — a proxy 502 answers with HTML. Calling .json()
    // on that throws a SyntaxError that hides the real problem, so parse defensively.
    const text = await response.text().catch(() => "");
    let data: Record<string, unknown>;
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      data = { error: "non_json_response", detail: text.slice(0, 200) };
    }
    return { httpStatus: response.status, data };
  };
}
