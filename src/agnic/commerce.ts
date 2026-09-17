/**
 * Agnic Checkout flow, over the HTTP routes (not the MCP confirmation-token layer).
 *
 * The whole job, in order: find something to buy (search/find/lookup/explore),
 * price it (preview = quote), place it (dispatch), and prove what happened
 * (read the order). Each function is pure over an injected `AgnicFetch`, so the
 * flow is unit-testable without a live token.
 *
 * Rules encoded from the docs:
 *  - Preview is a promise; dispatch is the only thing that spends money.
 *  - A 202 from dispatch means approval is STILL required — never treat it as done.
 *  - A cvv/currency step-up mints a fresh token each dispatch, so poll the approval
 *    endpoint; never poll by re-dispatching.
 *  - `retryable: null` means money may have moved — stop and reconcile, never retry.
 *  - succeeded confirms checkout, not delivery.
 */

import type { AgnicFetch } from "./client.js";

const AUTOFILL = "/api/autofill";

export interface AgnicMerchant {
  id: string;
  name?: string;
  domain?: string;
  rail?: string;
  is_test?: boolean;
}

export interface AgnicProduct {
  sku: string;
  title?: string;
  currency?: string;
  price_minor?: number;
  available?: boolean;
  merchant?: { merchant_id?: string };
  onboard?: { merchant_url?: string };
}

export interface ShipTo {
  name: string;
  street_address: string;
  address_locality: string;
  postal_code: string;
  address_country: string; // ISO-3166-1 alpha-2
  address_region?: string; // required for CA, US, AU
  phone?: string;
}

export interface Constraints {
  max_total_minor?: number;
  max_shipping_minor?: number;
}

export interface PreviewRequest {
  merchant_id: string;
  items: Array<{ sku: string; quantity: number }>;
  ship_to?: ShipTo;
  constraints?: Constraints;
  fulfillment_option_id?: string;
}

export interface FulfillmentOption {
  id: string;
  type?: string;
  label?: string;
  amount_minor?: number;
}

/** A priced, ready-to-place order plus the exact request that produced it. */
export interface ReadyQuote {
  state: "ready";
  request: PreviewRequest; // includes the chosen fulfillment_option_id
  expected_amount_minor: number;
  currency: string;
  amount_is_final: boolean;
  lineItem?: string;
}

export type PreviewResult =
  | ReadyQuote
  | { state: "choose_delivery"; options: FulfillmentOption[] }
  | { state: "unfulfillable" }
  | { state: "refused"; httpStatus: number; code?: unknown; blockers?: unknown };

export type DispatchResult =
  | { state: "poll"; orderId: string }
  | { state: "approval_required"; token: string; url?: string; expiresInSeconds?: number; reason?: string }
  | { state: "refused"; code?: unknown }
  | { state: "reconcile"; httpStatus?: number; code?: unknown };

export interface OrderResult {
  id?: string;
  status?: string;
  amount_charged_minor?: number;
  currency?: string;
  retryable?: boolean | null;
  retry_action?: "re_preview" | "poll" | "handoff" | "contact_support" | "none" | string;
  evidence?: { charge_state?: string; [k: string]: unknown } | null;
  test?: boolean;
  help?: string;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Search the vetted network for products by query + market (US, GB, CA, AU). */
export async function searchProducts(agnic: AgnicFetch, query: string, country = "CA", limit = 10): Promise<AgnicProduct[]> {
  const params = new URLSearchParams({ q: query, country, limit: String(Math.min(50, Math.max(1, limit))) });
  const { httpStatus, data } = await agnic(`${AUTOFILL}/products/search?${params}`);
  if (httpStatus !== 200) throw new Error(`agnic.search HTTP ${httpStatus}: ${str(data["error"]) ?? "unknown"}`);
  return (Array.isArray(data["products"]) ? (data["products"] as AgnicProduct[]) : []).filter((p) => p && p.sku);
}

/** Merchants already in the network. Keep the Shopify rail (the only one ship_to works on). */
export async function findShopifyMerchants(agnic: AgnicFetch, query?: string): Promise<AgnicMerchant[]> {
  const q = query ? `?${new URLSearchParams({ q: query })}` : "";
  const { httpStatus, data } = await agnic(`${AUTOFILL}/merchants${q}`);
  if (httpStatus !== 200) throw new Error(`agnic.merchants HTTP ${httpStatus}`);
  return (Array.isArray(data["merchants"]) ? (data["merchants"] as AgnicMerchant[]) : []).filter((m) => (m.rail ?? "shopify") === "shopify");
}

/**
 * Onboard a store Agnic has never seen ("Explore"): a model drives the live
 * checkout read-only, charges nothing, and records a reusable Recipe. Slow
 * (~2 min): returns a merchant_id once the explore order reaches "explored".
 */
export async function discoverMerchant(
  agnic: AgnicFetch,
  merchantUrl: string,
  goal: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ merchantId: string }> {
  const { httpStatus, data } = await agnic(`${AUTOFILL}/explore`, { method: "POST", body: { merchant_url: merchantUrl, goal: goal.slice(0, 200) } });
  if (httpStatus !== 200 || !str(data["order_id"])) throw new Error(`agnic.explore HTTP ${httpStatus}: ${str(data["error"]) ?? "no order_id"}`);
  const orderId = str(data["order_id"])!;
  if (str(data["status"]) === "explored" && str(data["merchant_id"])) return { merchantId: str(data["merchant_id"])! };

  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  const pollMs = opts.pollMs ?? 4000;
  for (;;) {
    await sleep(pollMs);
    const order = await readOrder(agnic, orderId);
    if (order.status === "explored") {
      const mid = str((order as Record<string, unknown>)["merchant_id"]) ?? str(data["merchant_id"]);
      if (mid) return { merchantId: mid };
      throw new Error("agnic.explore: explored but no merchant_id returned.");
    }
    if (order.status && !["exploring", "processing", "pending"].includes(order.status)) {
      throw new Error(`agnic.explore ended in status '${order.status}', not 'explored'.`);
    }
    if (Date.now() > deadline) throw new Error("agnic.explore timed out before 'explored'.");
  }
}

/**
 * Price an order (Preview). Returns a ready quote, a delivery choice, an
 * unfulfillable signal, or a refusal. `ready` only when a single total is known.
 */
export async function previewOrder(agnic: AgnicFetch, request: PreviewRequest): Promise<PreviewResult> {
  if (!request.merchant_id || request.items.length === 0) return { state: "refused", httpStatus: 400, code: "empty_request" };
  const snapshot: PreviewRequest = structuredClone(request);
  const { httpStatus, data } = await agnic(`${AUTOFILL}/shopify/quote`, { method: "POST", body: snapshot });
  if (httpStatus !== 200) return { state: "refused", httpStatus, code: data["error"], ...(data["blockers"] ? { blockers: data["blockers"] } : {}) };
  if (data["unfulfillable"]) return { state: "unfulfillable" };

  // Keep everything that delivers; drop pickup/none (an allowlist would silently
  // drop the `other` type Agnic assigns to methods it doesn't recognise).
  const options = (Array.isArray(data["fulfillment_options"]) ? (data["fulfillment_options"] as FulfillmentOption[]) : []).filter(
    (x) => x && x.type !== "pickup" && x.type !== "none",
  );
  const expected = num(data["expected_amount_minor"]);
  if (data["requires_fulfillment_choice"] || expected === undefined) return { state: "choose_delivery", options };

  const selected =
    options.find((x) => x.id === snapshot.fulfillment_option_id) ?? options.find((x) => x.id === str(data["selected_option_id"]));
  if (!selected || expected < 1) return { state: "choose_delivery", options };
  snapshot.fulfillment_option_id = selected.id;

  return {
    state: "ready",
    request: snapshot,
    expected_amount_minor: expected,
    currency: str(data["currency"]) ?? "USD",
    amount_is_final: data["amount_is_final"] !== false,
    ...(str(data["line_item"]) ? { lineItem: str(data["line_item"])! } : {}),
  };
}

/** The approved, dispatchable body: the same fields you quoted, plus the confirmation. */
export interface ApprovedRequest extends PreviewRequest {
  amount_minor: number;
  currency: string;
  user_confirmation_text: string;
  user_approved_at_iso: string;
  approval_token?: string;
}

/** Build the dispatch body from a ready quote and the user's literal confirmation. */
export function buildApprovedRequest(quote: ReadyQuote, confirmation: { text: string; approvedAt: string }): ApprovedRequest {
  if (!confirmation.text?.trim() || confirmation.text.length > 500 || !Number.isFinite(Date.parse(confirmation.approvedAt))) {
    throw new Error("Record the user's actual confirmation text and an ISO timestamp.");
  }
  return {
    ...structuredClone(quote.request),
    amount_minor: quote.expected_amount_minor,
    currency: quote.currency,
    user_confirmation_text: confirmation.text,
    user_approved_at_iso: confirmation.approvedAt,
  };
}

/** Place the approved order. Never call twice for the same order — that double-charges. */
export async function dispatchOrder(agnic: AgnicFetch, request: ApprovedRequest): Promise<DispatchResult> {
  const { httpStatus, data } = await agnic(`${AUTOFILL}/dispatch`, { method: "POST", body: request });
  if (httpStatus === 202 && data["approval_required"]) {
    return {
      state: "approval_required",
      token: str(data["approval_token"]) ?? "",
      ...(str(data["approval_url"]) ? { url: str(data["approval_url"])! } : {}),
      ...(num(data["expires_in"]) !== undefined ? { expiresInSeconds: num(data["expires_in"])! } : {}),
      ...(str(data["reason"]) ? { reason: str(data["reason"])! } : {}),
    };
  }
  // An error can still carry an order id: read it before deciding.
  if (str(data["order_id"])) return { state: "poll", orderId: str(data["order_id"])! };
  if (httpStatus === 409) return { state: "refused", code: data["error"] };
  return { state: "reconcile", httpStatus, code: data["error"] };
}

/** Poll a passkey/cvv/currency step-up until approved. Never re-dispatch to poll. */
export async function waitForApproval(agnic: AgnicFetch, token: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  const pollMs = opts.pollMs ?? 2000;
  for (;;) {
    const { data } = await agnic(`/api/approvals/${encodeURIComponent(token)}`);
    const status = str(data["status"]);
    if (status === "approved") return true;
    if (status && ["denied", "rejected", "expired", "failed"].includes(status)) return false;
    if (Date.now() > deadline) return false;
    await sleep(pollMs);
  }
}

/** Read an order's authoritative result. Private backend data — never forward to a user. */
export async function readOrder(agnic: AgnicFetch, orderId: string): Promise<OrderResult> {
  const { httpStatus, data } = await agnic(`${AUTOFILL}/orders/${encodeURIComponent(orderId)}`);
  if (httpStatus !== 200) throw new Error(`agnic.order HTTP ${httpStatus}`);
  return data as OrderResult;
}

/** The single next action for a finished/finishing order — what your code branches on. */
export function nextOrderAction(order: OrderResult): "capture_once" | "poll_later" | "human_handoff" | "release_hold_once" | "reconcile" {
  if (["succeeded", "delivered"].includes(order.status ?? "")) return "capture_once";
  if (order.retry_action === "poll") return "poll_later";
  if (order.retry_action === "handoff") return "human_handoff";
  if (order.retryable == null) return "reconcile"; // null ⇒ money may have moved
  // Refused before the card (Agnic's own refusal): release the hold, don't ticket.
  const refusedBeforeCard = order.evidence?.charge_state === "none" || (order.evidence == null && order.retry_action === "re_preview");
  if (refusedBeforeCard && ["re_preview", "none"].includes(order.retry_action ?? "")) return "release_hold_once";
  return "reconcile";
}
