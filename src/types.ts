/**
 * Shared contracts — the contract between lanes.
 *
 * These mirror `docs/aisle-pipeline.md` §6–§11 and the scaffold's
 * `packages/types`. Agree them once and stop renegotiating them.
 *
 * Pipeline (aisle-pipeline.md §3):
 *   402 → classify (Blocker) → freeze TaskCheckpoint (origin from CONFIG)
 *   → entitlement check → Quote → policy gate → signed PurchaseMandate
 *   → one human tap → fast lane | slow lane → verify entitlement → replay.
 */

// ---------------------------------------------------------------- blockers (§6)

export type BlockerType =
  | "INSUFFICIENT_CREDITS"
  | "QUOTA_EXCEEDED"
  | "PLAN_REQUIRED"
  | "SEAT_REQUIRED"
  | "PAYMENT_REQUIRED"
  | "UNKNOWN";

export interface Blocker {
  type: BlockerType;
  /** "image_credits" | "usd_balance" | "seats" | "plan" … */
  resource: string;
  /** Parsed only if the vendor actually told us. */
  required?: number;
  /** "low" = body unavailable (e.g. evicted on the web path), classified on status alone. */
  confidence: "high" | "low";
  raw: unknown;
}

// ---------------------------------------------------------------- origin (§2.3)

/**
 * The single most important invariant in this codebase: origins come from
 * configuration (upstreams.json) or from an enrollment row. NEVER from a tool
 * result, a page, an error body, or a model.
 */
export interface LockedOrigin {
  provider: string;
  /** Where the API 402s from. */
  canonicalOrigin: string;
  /** Where purchases happen. The only origin money may move to. */
  billingOrigin: string;
  source: "task_configuration" | "enrollment";
  lockedAt: string;
}

// ---------------------------------------------------------------- checkpoint (§7)

export interface TaskCheckpoint {
  taskId: string;
  agentId: string | null;
  toolCallId: string;
  surface: "cli" | "web";

  /** null on CLI paths — you don't get it, don't fake it. */
  originalGoal: string | null;
  tool: string;
  /** The EXACT arguments of the blocked call; replayed verbatim. */
  arguments: unknown;
  /** sha256 of canonical JSON (sorted keys, no whitespace). */
  argumentsHash: string;

  origin: LockedOrigin;
  blocker: Blocker;
  createdAt: string;
}

// ---------------------------------------------------------------- entitlement (§8)

/** A cache, never truth. Always re-read the vendor before and after buying. */
export interface Entitlement {
  userId: string;
  provider: string;
  /** Distinguishes infra-openrouter from user-openrouter (§16.5). */
  accountId: string | null;
  resource: string;
  balance: number | null;
  plan: string | null;
  seatsUsed: number | null;
  seatsTotal: number | null;
  status: "active" | "expired" | "cancelled";
  verifiedAt: string;
}

// ---------------------------------------------------------------- quote (§9)

/** A purchasable package, from the registry, JSON-LD, or the pricing page. */
export interface PurchaseOffer {
  productId: string;
  label: string;
  unitsGranted: number;
  price: number;
  currency: string;
  billing: "one_time" | "subscription";
  autoRenew: boolean;
}

export interface Quote {
  provider: string;
  /** From the LOCKED origin, never from the page. */
  billingOrigin: string;
  productId: string;
  quantity: number;
  unitsGranted: number;
  price: number;
  currency: string;
  billing: "one_time" | "subscription";
  autoRenew: boolean;
  /** User-facing prose, generated in the engine not the UI. */
  reason: string;
}

/** What the task needs, in vendor-agnostic terms, to unblock. */
export interface Requirement {
  resource: string;
  /** Minimum units that must exist after the purchase. */
  amount: number;
}

// ---------------------------------------------------------------- policy (§10)

export interface Limits {
  perPurchase: number;
  perTask: number;
  perDay: number;
  maxAttemptsPerTask: number;
  maxResolverCallsPerJob: number;
}

export interface SpendState {
  task: number;
  day: number;
  attempts: number;
}

export type RefusalReason =
  | "ORIGIN_VIOLATION"
  | "PER_PURCHASE_CEILING"
  | "PER_TASK_CEILING"
  | "PER_DAY_CEILING"
  | "CIRCUIT_OPEN"
  | "NO_VIABLE_OFFER"
  | "RESOLUTION_EXHAUSTED"
  | "INFRA_BLOCKED";

export interface Refusal {
  ok: false;
  reason: RefusalReason;
  /** Always carries cumulative spend where relevant. "Blocked" alone is a dead end. */
  detail: Record<string, unknown>;
  message: string;
}

export type GateResult = { ok: true } | Refusal;

// ---------------------------------------------------------------- mandate (§11)

/** Single-use, HMAC-signed authorization. The worker receives this, never a card number. */
export interface PurchaseMandate {
  mandateId: string;
  taskId: string;
  recoveryJobId: string;
  userId: string;

  provider: string;
  billingOrigin: string;
  productId: string;
  quantity: number;
  unitsGranted: number;

  /** A CAP, not a price. Tax and FX move the real number. */
  maximumAmount: number;
  currency: string;
  billingType: "one_time";
  autoRenew: false;

  /** 10 minutes. Approval is a live decision. */
  expiresAt: string;
  nonce: string;
  /** HMAC-SHA256 over the canonical serialization of every other field. */
  signature: string;
}

/** What the checkout page says, read immediately before submit (§18 Gate 1). */
export interface StagedCheckout {
  lineItem: string;
  amount: number;
  currency: string;
  billingPeriod: "one_time" | "subscription";
  autoRenew: boolean;
}

/** A purchase brought right up to the point of confirmation, not yet executed. */
export interface StagedPurchase extends StagedCheckout {
  offer: PurchaseOffer;
  /** Opaque adapter state needed to confirm (e.g. a checkout URL). */
  checkoutRef: string;
}

/** The result of reading authoritative account state back from the vendor. */
export interface PurchaseVerification {
  confirmed: boolean;
  transactionId?: string;
  balanceAfter?: number;
  accountId?: string;
  resource?: string;
  reason?: string;
}

// ---------------------------------------------------------------- resume (§19, §20)

/**
 * Internal resume record. Per §2.2 the blocked MCP call blocks and the agent
 * never sees this — the gateway uses it as the `resume:{taskId}:{toolCallId}`
 * idempotency key and replays `resumeAction` with the exact same arguments.
 */
export interface ResumeToken {
  id: string;
  taskId: string;
  failedToolCallId: string;
  resumeAction: {
    tool: string;
    /** The ORIGINAL arguments, replayed verbatim — never regenerated. */
    arguments: unknown;
  };
  entitlementRequirement: {
    provider: string;
    resource: string;
    minimumAmount: number;
  };
  createdAt: string;
  expiresAt: string;
}

// ---------------------------------------------------------------- lanes (§13–§15)

/** Both lanes accept the same request: an approved mandate for a frozen checkpoint. */
export interface RecoveryRequest {
  checkpoint: TaskCheckpoint;
  quote: Quote;
  mandate: PurchaseMandate;
  /**
   * The minimum the task actually needs (not the package size). Defaults to
   * `{ resource: checkpoint.blocker.resource, amount: checkpoint.blocker.required ?? quote.unitsGranted }`.
   */
  requirement?: Requirement;
}

/** @deprecated Use `RecoveryRequest`. Kept so existing host code keeps compiling. */
export type FastLaneRequest = RecoveryRequest;

/**
 * Both lanes converge on the same result shape. The host doesn't care whether
 * recovery happened via a purchase tool (fast) or a browser (slow).
 */
export interface RecoveryResult {
  lane: "fast" | "slow";
  /** null when nothing was bought (ALREADY_COVERED). */
  purchaseId: string | null;
  verifiedEntitlement: Entitlement;
  resumeToken: ResumeToken;
  /** True when the balance already cleared the requirement and nothing was bought (§8). */
  alreadyCovered: boolean;
  /** Steel live/replay viewer URL — part of the audit trail (slow lane). */
  sessionViewerUrl?: string;
  /** Receipt/invoice/license files captured from the Steel session (slow lane). */
  receiptFileIds?: string[];
}

/** @deprecated Use `RecoveryResult`. */
export type FastLaneResult = RecoveryResult;

// ---------------------------------------------------------------- events (§22)

export type AisleEventType =
  | "TASK_CREATED" | "TOOL_CALL_STARTED" | "TOOL_CALL_FAILED"
  | "RECOVERY_CREATED" | "CHECKPOINT_FROZEN"
  | "ENTITLEMENT_CHECK_STARTED" | "ENTITLEMENT_CHECKED" | "ALREADY_COVERED"
  | "QUOTE_CREATED" | "POLICY_PASSED" | "POLICY_REFUSED"
  | "MANDATE_SIGNED" | "APPROVAL_REQUESTED" | "APPROVAL_GRANTED" | "APPROVAL_REJECTED"
  | "PURCHASE_STARTED" | "STEEL_SESSION_CREATED" | "PROFILE_RESTORED"
  | "RESOLVER_CALLED" | "CHECKOUT_STAGED" | "MANDATE_COMPARISON_PASSED"
  | "PURCHASE_SUBMITTED" | "TAKEOVER_REQUESTED" | "TAKEOVER_RESOLVED"
  | "PURCHASE_COMPLETED" | "PURCHASE_RESULT_UNKNOWN" | "RECEIPT_CAPTURED"
  | "ENTITLEMENT_VERIFIED" | "TRACE_EXPORTED"
  | "TOOL_CALL_RETRIED" | "TOOL_CALL_SUCCEEDED" | "TASK_RESUMED"
  | "ADAPTER_RECORDED" | "INFRA_CREDITS_EXHAUSTED"
  | "VIEWER_FROZEN" | "VIEWER_UNFROZEN" | "ENROLLMENT_SUGGESTED";
