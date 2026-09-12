import type { FailureClassification } from "./event.js";
import {
  normalizeError,
  type NormalizedError,
} from "./error-normalizer.js";

export interface ClassifiedFailure {
  classification: FailureClassification;
  recoverable: boolean;
  reason: string;
}

export function classifyFailure(error: unknown): ClassifiedFailure {
  const normalized = normalizeError(error);

  return classifyNormalizedError(normalized);
}

function classifyNormalizedError(
  error: NormalizedError,
): ClassifiedFailure {
  const status = error.status;
  const code = error.code?.toLowerCase();
  const message = error.message?.toLowerCase() ?? "";

  /*
   * Explicit payment / credit error codes have highest priority.
   * These are the strongest signals that the failure may be recoverable
   * through a purchase or plan upgrade.
   */
  if (
    code === "insufficient_credits" ||
    code === "credits_exhausted"
  ) {
    return {
      classification: "INSUFFICIENT_CREDITS",
      recoverable: true,
      reason:
        "The provider reported that the account does not have enough credits.",
    };
  }

  if (
    code === "quota_exceeded" ||
    message.includes("quota exceeded")
  ) {
    return {
      classification: "QUOTA_EXCEEDED",
      recoverable: true,
      reason:
        "The provider reported that the account has exceeded its usage quota.",
    };
  }

  if (
    code === "plan_required" ||
    message.includes("plan required") ||
    message.includes("paid plan")
  ) {
    return {
      classification: "PLAN_REQUIRED",
      recoverable: true,
      reason:
        "The requested operation requires a paid plan.",
    };
  }

  /*
   * HTTP 402 is the standard payment-required signal.
   */
  if (
    status === 402 ||
    message.includes("payment required")
  ) {
    return {
      classification: "PAYMENT_REQUIRED",
      recoverable: true,
      reason:
        "The provider returned a payment-required response.",
    };
  }

  /*
   * Authentication errors must never trigger a purchase.
   */
  if (
    status === 401 ||
    code === "unauthorized" ||
    code === "authentication_required" ||
    message.includes("unauthorized") ||
    message.includes("authentication required")
  ) {
    return {
      classification: "AUTH_REQUIRED",
      recoverable: false,
      reason:
        "The request requires authentication rather than payment.",
    };
  }

  /*
   * Permission errors must never trigger a purchase.
   */
  if (
    status === 403 ||
    code === "forbidden" ||
    message.includes("forbidden")
  ) {
    return {
      classification: "FORBIDDEN",
      recoverable: false,
      reason:
        "The authenticated user does not have permission to perform this operation.",
    };
  }

  /*
   * Resource-not-found errors are unrelated to payment.
   */
  if (
    status === 404 ||
    code === "not_found" ||
    message.includes("not found")
  ) {
    return {
      classification: "NOT_FOUND",
      recoverable: false,
      reason:
        "The requested resource was not found.",
    };
  }

  /*
   * Generic server failures should not cause an automated purchase.
   */
  if (
    status !== undefined &&
    status >= 500 &&
    status <= 599
  ) {
    return {
      classification: "SERVER_ERROR",
      recoverable: false,
      reason:
        "The provider returned a server-side failure.",
    };
  }

  return {
    classification: "UNKNOWN",
    recoverable: false,
    reason:
      "The error could not be identified as a recoverable payment failure.",
  };
}