/**
 * Shared contracts for the top-up-agent fast lane.
 *
 * The top-up-agent runs *inside* a host coding agent (Hermes / Claude / Codex).
 * The host owns the user's task and the MCP transport; this module is invoked
 * only after a purchase has already been approved (mandate signed), and its job
 * is narrow:
 *
 *   1. Detect whether the vendor exposes WebMCP purchase tools.
 *   2. If so, call those tools to buy the minimum entitlement.
 *   3. Verify the entitlement actually landed.
 *   4. Hand back a resume token so the host can replay the failed tool call.
 */

// ---------------------------------------------------------------------------
// Failure / blocker vocabulary (classified upstream; we only consume it)
// ---------------------------------------------------------------------------

export type BlockerType =
  | "INSUFFICIENT_CREDITS"
  | "QUOTA_EXCEEDED"
  | "PLAN_REQUIRED"
  | "SEAT_REQUIRED"
  | "PAYMENT_REQUIRED"
  | "UNKNOWN";

// ---------------------------------------------------------------------------
// Task checkpoint — the execution position we must restore
// ---------------------------------------------------------------------------

export interface ToolCall {
  /** Stable id of the tool call that failed, used for idempotent replay. */
  id: string;
  tool: string;
  arguments: unknown;
}

export interface TaskCheckpoint {
  taskId: string;
  agentId: string;
  originalGoal: string;
  /** The exact call that hit the paywall; replayed verbatim on resume. */
  failedToolCall: ToolCall;
  origin: PurchaseOrigin;
  failure: {
    type: BlockerType;
    rawError: unknown;
  };
}

// ---------------------------------------------------------------------------
// Origin lock — a hard security boundary
// ---------------------------------------------------------------------------

export interface PurchaseOrigin {
  provider: string;
  /** Canonical origin authorized by task configuration, e.g. https://api.higgsfield.ai */
  canonicalOrigin: string;
  /** Only "task_configuration" is ever trusted to authorize an origin. */
  source: "task_configuration";
  lockedAt: string;
}

// ---------------------------------------------------------------------------
// Quote + Mandate (produced upstream by the quote engine / approval flow)
// ---------------------------------------------------------------------------

export interface Quote {
  provider: string;
  purchase: {
    productId: string;
    quantity: number;
    /** Credits (or seats/units) the purchase is expected to add. */
    credits: number;
    price: number;
    currency: string;
  };
  billing: "one_time" | "subscription";
  autoRenew: boolean;
  reason: string;
}

/** Single-use authorization. The worker receives this, never a card number. */
export interface PurchaseMandate {
  mandateId: string;
  taskId: string;
  /** Must equal the WebMCP session's origin before any purchase is made. */
  origin: string;
  provider: string;
  productId: string;
  maximumAmount: number;
  currency: string;
  billingType: "one_time";
  autoRenew: false;
  expiresAt: string;
  nonce: string;
  /** Opaque signature; verified by `verifyMandateSignature` (stubbed for the demo). */
  signature: string;
}

// ---------------------------------------------------------------------------
// Entitlement
// ---------------------------------------------------------------------------

export interface Entitlement {
  provider: string;
  accountId: string;
  resource: string;
  /** Current balance of the resource after verification. */
  balance: number;
  plan?: string;
  status: "active" | "expired" | "cancelled";
  lastVerifiedAt: string;
}

// ---------------------------------------------------------------------------
// Resume token — the handoff artifact back to the host agent
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fast-lane request / result (this module's public boundary)
// ---------------------------------------------------------------------------

export interface FastLaneRequest {
  checkpoint: TaskCheckpoint;
  quote: Quote;
  mandate: PurchaseMandate;
  /**
   * The minimum the task actually needs (not the package size). Used by the
   * slow lane to pick the minimum offer and to set the verification threshold.
   * Defaults to the quoted package's units when omitted.
   */
  requirement?: Requirement;
}

/** Both lanes accept the same request. */
export type RecoveryRequest = FastLaneRequest;

export interface FastLaneResult {
  purchaseId: string;
  verifiedEntitlement: Entitlement;
  resumeToken: ResumeToken;
}

/**
 * Both lanes converge on the same result shape. The host doesn't care whether
 * recovery happened via WebMCP (fast) or a browser (slow) — it gets a verified
 * entitlement and a resume token either way.
 */
export type RecoveryResult = FastLaneResult & { lane: "fast" | "slow" };

// ---------------------------------------------------------------------------
// Slow-lane (browser) domain types
// ---------------------------------------------------------------------------

/** What the task needs, in vendor-agnostic terms, to unblock. */
export interface Requirement {
  resource: string;
  /** Minimum units (credits/seats/etc.) that must exist after the purchase. */
  amount: number;
}

/** A purchasable package discovered on the vendor's pricing surface. */
export interface PurchaseOffer {
  productId: string;
  label: string;
  /** Units the package grants (credits, seats, …). */
  units: number;
  price: number;
  currency: string;
  billing: "one_time" | "subscription";
}

/** A purchase brought right up to the point of confirmation, not yet executed. */
export interface StagedPurchase {
  offer: PurchaseOffer;
  /** Opaque adapter state needed to confirm (e.g. a checkout URL / element ref). */
  checkoutRef: string;
  /** What the vendor's checkout currently says the total is. */
  observedTotal: number;
  observedCurrency: string;
}

/** The result of confirming the purchase actually landed on the account. */
export interface PurchaseVerification {
  confirmed: boolean;
  transactionId?: string;
  balanceAfter?: number;
  accountId?: string;
  resource?: string;
  reason?: string;
}
