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

export { assertPurchaseAllowed, verifyMandateSignature, normalizeOrigin } from "./fast-lane/guards.js";
export {
  InMemoryIdempotencyStore,
  purchaseKey,
} from "./fast-lane/idempotency.js";
export type { IdempotencyStore, PurchaseRecord } from "./fast-lane/idempotency.js";

export { buildResumeToken, isResumeTokenExpired } from "./resume/resume-token.js";

// ---- Slow lane (Steel + Playwright + CDP, computer-use fallback) ----------
export { runSlowLane } from "./slow-lane/executor.js";
export type { SlowLaneDeps, SlowLaneEvent, TakeoverContext } from "./slow-lane/executor.js";
export { SteelBrowserProvider } from "./slow-lane/steel-provider.js";
export type { SteelProviderOptions } from "./slow-lane/steel-provider.js";
export { InMemoryProfileStore, FileProfileStore } from "./slow-lane/profiles.js";
export type { ProfileStore } from "./slow-lane/profiles.js";
export {
  DeterministicStepError,
  chooseMinimumOffer,
  selectOffer,
} from "./slow-lane/vendor-adapter.js";
export type { VendorPurchaseAdapter } from "./slow-lane/vendor-adapter.js";
export {
  GenericVendorAdapter,
  parseOffersFromText,
  extractPrice,
  extractUnits,
} from "./slow-lane/adapters/generic-vendor-adapter.js";
export type { GenericAdapterConfig } from "./slow-lane/adapters/generic-vendor-adapter.js";
export {
  ScriptedComputerUseAgent,
  createAnthropicComputerUseAgent,
  createOpenRouterComputerUseAgent,
  parseComputerUseAction,
} from "./slow-lane/computer-use.js";
export type {
  ComputerUseAgent,
  ComputerUseAction,
  ComputerUseOutcome,
  AnthropicLike,
  OpenRouterComputerUseOptions,
  OpenRouterFetch,
} from "./slow-lane/computer-use.js";
export { originOf } from "./slow-lane/browser.js";
export type {
  BrowserProvider,
  BrowserSession,
  BrowserProfile,
  PageLike,
  ControlSurface,
  CreateSessionOptions,
} from "./slow-lane/browser.js";

export {
  FastLaneError,
  NoFastLaneError,
  MandateRejectedError,
  PurchaseFailedError,
  PurchaseVerificationError,
  TakeoverRequiredError,
} from "./errors.js";

export type * from "./types.js";
