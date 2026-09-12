export interface NormalizedError {
  status?: number;
  code?: string;
  message?: string;
  raw: unknown;
}

/**
 * Converts different tool/provider error formats into one predictable shape.
 */
export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      message: error.message,
      raw: error,
    };
  }

  if (typeof error === "string") {
    const statusMatch = error.match(/\bHTTP\s+(\d{3})\b/i);
    const paymentMatch = error.match(/\b(402|401|403|404|429|500)\b/);

    return {
      status: statusMatch
        ? Number(statusMatch[1])
        : paymentMatch
          ? Number(paymentMatch[1])
          : undefined,
      message: error,
      raw: error,
    };
  }

  if (typeof error === "object" && error !== null) {
    const value = error as Record<string, unknown>;

    const status = extractNumber(value.status, value.statusCode);

    const code = extractString(
      value.code,
      value.errorCode,
      value.error_type,
      typeof value.error === "string" ? value.error : undefined,
    );

    const message = extractString(
      value.message,
      typeof value.error === "string" ? value.error : undefined,
      value.details,
    );

    return {
      status,
      code,
      message,
      raw: error,
    };
  }

  return {
    raw: error,
  };
}

function extractNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number") {
      return value;
    }

    if (typeof value === "string" && /^\d+$/.test(value)) {
      return Number(value);
    }
  }

  return undefined;
}

function extractString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}