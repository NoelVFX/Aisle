/**
 * top-up-agent — fast lane.
 *
 * Public surface consumed by the host coding agent (Hermes / Claude / Codex).
 *
 * Typical host flow:
 *   1. A tool call hits a paywall; the host's classifier + quote engine produce
 *      a `Quote` and a signed `PurchaseMandate`, and the user approves it.
 *   2. The host connects to the vendor's WebMCP endpoint and hands us the
 *      `WebMcpSession`.
 *   3. The host calls `runFastLane(request, { session })`.
 *      - If WebMCP isn't available it throws `NoFastLaneError` → host uses the
 *        slow lane (Steel + Playwright).
 *      - Otherwise it returns a verified entitlement + a resume token.
 *   4. The host activates the resume token: replays `resumeAction` verbatim and
 *      the original task continues.
 */

export { runFastLane } from "./fast-lane/executor.js";
export type { FastLaneDeps, FastLaneEvent } from "./fast-lane/executor.js";

export { detectWebMcp } from "./webmcp/detector.js";
export type { DetectionResult, FastLaneCapability } from "./webmcp/detector.js";
export type {
  WebMcpSession,
  WebMcpTool,
  WebMcpToolResult,
  WebMcpToolAnnotations,
} from "./webmcp/session.js";

export { McpWebMcpSession, connectMcpWebMcpSession } from "./webmcp/mcp-http-session.js";
export type { McpWebMcpSessionOptions } from "./webmcp/mcp-http-session.js";

export {
  assertPurchaseAllowed,
  signMandate,
  verifyMandateSignature,
  normalizeOrigin,
} from "./fast-lane/guards.js";
export {
  InMemoryIdempotencyStore,
  purchaseKey,
} from "./fast-lane/idempotency.js";
export type { IdempotencyStore, PurchaseRecord, PutIfAbsentResult } from "./fast-lane/idempotency.js";

export { buildResumeToken, isResumeTokenExpired } from "./resume/resume-token.js";

export {
  FastLaneError,
  NoFastLaneError,
  MandateRejectedError,
  PurchaseFailedError,
  PurchaseInFlightError,
  PurchaseVerificationError,
} from "./errors.js";

export type * from "./types.js";
