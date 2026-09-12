/**
 * Converts different tool/provider error formats into one predictable shape,
 * so ONE classifier serves both transports (MCP tool errors and CDP wire
 * responses — aisle-pipeline.md §5.6, §6).
 *
 * Accepted shapes include:
 *   { status: 402, error: "insufficient_credits", required_credits: 1067 }
 *   { statusCode: 429, code: "quota_exceeded", headers: { "retry-after": "10" } }
 *   { isError: true, status: 402, headers, error: { code, message, … } }   // gateway shape
 *   { error: { code: 402, message: "Insufficient credits" } }                // OpenRouter body
 *   Error("HTTP 402 Payment Required") / "HTTP 402 Payment Required"
 */

export interface NormalizedError {
  status?: number;
  code?: string;
  message?: string;
  /** Seconds from a Retry-After header/field, when present and numeric. */
  retryAfterSeconds?: number;
  /** The vendor response body (unwrapped from a gateway `error` envelope). */
  body?: unknown;
  raw: unknown;
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    const status = statusFromText(error.message);
    return { ...(status === undefined ? {} : { status }), message: error.message, raw: error };
  }

  if (typeof error === "string") {
    const status = statusFromText(error) ?? loneStatus(error);
    return { ...(status === undefined ? {} : { status }), message: error, body: error, raw: error };
  }

  if (typeof error === "object" && error !== null) {
    const value = error as Record<string, unknown>;
    const nested = isRecord(value["error"]) ? value["error"] : undefined;

    const status = extractNumber(
      value["status"],
      value["statusCode"],
      value["httpStatus"],
      nested?.["status"],
      typeof nested?.["code"] === "number" ? nested["code"] : undefined,
    );

    const code = extractString(
      value["code"],
      value["errorCode"],
      value["error_type"],
      typeof value["error"] === "string" ? value["error"] : undefined,
      typeof nested?.["code"] === "string" ? nested["code"] : undefined,
      nested?.["type"],
    );

    const message = extractString(
      value["message"],
      typeof value["error"] === "string" ? value["error"] : undefined,
      value["details"],
      nested?.["message"],
    );

    const retryAfterSeconds = extractNumber(
      headerOf(value["headers"], "retry-after"),
      value["retryAfter"],
      value["retry_after"],
      nested?.["retry_after"],
    );

    const out: NormalizedError = { raw: error, body: nested ?? value };
    if (status !== undefined) out.status = status;
    if (code !== undefined) out.code = code;
    if (message !== undefined) out.message = message;
    if (retryAfterSeconds !== undefined) out.retryAfterSeconds = retryAfterSeconds;
    return out;
  }

  return { raw: error };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function statusFromText(text: string): number | undefined {
  const m = text.match(/\bHTTP\s+(\d{3})\b/i);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

function loneStatus(text: string): number | undefined {
  const m = text.match(/\b(402|401|403|404|429|500)\b/);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

function headerOf(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== "object") return undefined;
  const maybeGet = (headers as { get?: unknown }).get;
  if (typeof maybeGet === "function") {
    return (maybeGet as (n: string) => unknown).call(headers, name) ?? undefined;
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
}

function extractNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  }
  return undefined;
}

function extractString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
