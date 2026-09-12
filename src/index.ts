/**
 * top-up-agent — the Aisle recovery engine as a library.
 *
 * Pipeline (docs/aisle-pipeline.md §3):
 *   tool call → 402 → classify → freeze checkpoint (origin from config)
 *   → entitlement check → quote → policy gate → signed mandate → one human tap
 *   → fast lane | slow lane → verify entitlement → replay the original call
 *
 * This package implements the engine. The MCP gateway, the REST/SSE control
 * plane, the approval page and the database live in separate apps per the docs.
 */

// ---- Wake-up: detect + classify + dedupe --------------------------------
export { normalizeError } from "./error-normalizer.js";
export type { NormalizedError } from "./error-normalizer.js";
export { classifyFailure, isRateLimitNotWall, registerVendorRules, RECOVERABLE_BLOCKERS } from "./classifier.js";
export type { ClassifiedFailure, ClassifyOptions, VendorRule } from "./classifier.js";
export { ErrorInterceptor } from "./interceptor.js";
export type { ToolCallInfo } from "./interceptor.js";
export { WakeUpManager, fingerprintKey } from "./wakeup-manager.js";
export type { WakeUpHandler, WakeUpManagerOptions } from "./wakeup-manager.js";
export type { AgentContext, FailureClassification, FailureEvent } from "./event.js";

// ---- Core: checkpoint, hashing, idempotency keys --------------------------
export { freezeCheckpoint, lockOrigin, requirementFor } from "./core/checkpoint.js";
export type { FreezeInput, UpstreamConfig } from "./core/checkpoint.js";
export {
  adapterKey,
  approvalKey,
  argumentsHash,
  canonicalJson,
  purchaseKey,
  requirementHash,
  resumeKey,
  sha256,
} from "./core/hash.js";

// ---- Quote, policy, mandate ------------------------------------------------
export { buildQuote } from "./quote/quote.js";
export type { BuildQuoteInput, QuoteOutcome } from "./quote/quote.js";
export { canonicalize, gate, loadLimits, sameOrigin, InMemorySpendLedger } from "./policy/policy.js";
export type { SpendLedger } from "./policy/policy.js";
export { assertMatchesMandate, signMandate, verifyMandate } from "./mandate/mandate.js";
export type { MandateKeyOptions, SignMandateContext } from "./mandate/mandate.js";

// ---- Fast lane -------------------------------------------------------------
export { runFastLane } from "./fast-lane/executor.js";
export type { FastLaneDeps, FastLaneEvent } from "./fast-lane/executor.js";
export { detectWebMcp } from "./webmcp/detector.js";
export type { DetectionResult, FastLaneCapability } from "./webmcp/detector.js";
export type { WebMcpSession, WebMcpTool, WebMcpToolResult, WebMcpToolAnnotations } from "./webmcp/session.js";
export { assertPurchaseAllowed, normalizeOrigin } from "./fast-lane/guards.js";
export type { GuardContext } from "./fast-lane/guards.js";
export { InMemoryIdempotencyStore, blocksNewPurchase, purchaseKeyFor } from "./fast-lane/idempotency.js";
export type { IdempotencyStore, PurchaseRecord, PurchaseStatus } from "./fast-lane/idempotency.js";
export { buildResumeToken, isResumeTokenExpired } from "./resume/resume-token.js";

// ---- Slow lane (Steel + Playwright over CDP) --------------------------------
export { runSlowLane } from "./slow-lane/executor.js";
export type { SlowLaneDeps, SlowLaneEvent, TakeoverContext } from "./slow-lane/executor.js";
export {
  SteelBrowserProvider,
  assertProfileMounted,
  assertTimeoutApplied,
  buildSessionCreateParams,
  waitForProfileReady,
  CHECKOUT_TIMEOUT_MS,
  PROFILE_READY_TIMEOUT_MS,
  PURCHASE_SESSION_TIMEOUT_MS,
} from "./slow-lane/steel-provider.js";
export type {
  ProfileReadyOptions,
  SessionPlan,
  SteelProfilesClient,
  SteelProviderOptions,
} from "./slow-lane/steel-provider.js";
export { InMemoryProfileStore, FileProfileStore } from "./slow-lane/profiles.js";
export type { ProfileStore } from "./slow-lane/profiles.js";
export { DeterministicStepError, chooseMinimumOffer, selectOffer } from "./slow-lane/vendor-adapter.js";
export type { VendorPurchaseAdapter } from "./slow-lane/vendor-adapter.js";
export {
  GenericVendorAdapter,
  detectAutoRenew,
  detectBillingPeriod,
  extractBalance,
  extractPrice,
  extractUnits,
  parseOffersFromText,
} from "./slow-lane/adapters/generic-vendor-adapter.js";
export type { GenericAdapterConfig } from "./slow-lane/adapters/generic-vendor-adapter.js";
export {
  ScriptedComputerUseAgent,
  VISION_PROFILE,
  createOpenRouterComputerUseAgent,
  parseComputerUseAction,
} from "./slow-lane/computer-use.js";
export { SteelComputerControl } from "./slow-lane/steel-computer.js";
export type { SteelComputerClient } from "./slow-lane/steel-computer.js";
export type {
  ComputerUseAction,
  ComputerUseAgent,
  ComputerUseOutcome,
  OpenRouterComputerUseOptions,
  OpenRouterFetch,
} from "./slow-lane/computer-use.js";
export { originOf } from "./slow-lane/browser.js";
export type {
  BrowserProfile,
  BrowserProvider,
  BrowserSession,
  ControlSurface,
  CreateSessionOptions,
  PageLike,
} from "./slow-lane/browser.js";

// ---- Errors + contracts ------------------------------------------------------
export {
  FastLaneError,
  InfraBlockedError,
  MandateMismatchError,
  MandateRejectedError,
  NoFastLaneError,
  PurchaseFailedError,
  PurchaseVerificationError,
  ResolutionExhaustedError,
  TakeoverRequiredError,
} from "./errors.js";

export type * from "./types.js";
