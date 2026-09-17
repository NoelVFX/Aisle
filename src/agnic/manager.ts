/**
 * Aisle's commerce agent over the Agnic Checkout rail.
 *
 *   discover (search / explore) → preview (a promise) → ONE human approval →
 *   dispatch (the only thing that spends) → follow the order → receipt
 *
 * Aisle is the commerce agent (find, confirm, receipt); Agnic is the checkout
 * engine (explore/pay/vault/evidence). Nothing is charged before the user taps
 * approve, dispatch runs at most once per approval, and a 202 step-up (passkey /
 * cvv / currency) is surfaced to the user, never treated as done. Where the flow
 * ends is a RECEIPT — the user does their own setup/integration afterwards.
 */

import { randomUUID } from "node:crypto";
import type { AgnicFetch } from "./client.js";
import {
  buildApprovedRequest,
  discoverMerchant,
  dispatchOrder,
  nextOrderAction,
  previewOrder,
  readOrder,
  searchProducts,
  waitForApproval,
  type ApprovedRequest,
  type Constraints,
  type PreviewRequest,
  type ReadyQuote,
  type ShipTo,
} from "./commerce.js";

export interface ShopRequest {
  taskId: string;
  /** Natural-language ask, used as the product search query when no sku is given. */
  prompt: string;
  country?: string;
  /** Optional explicit target (e.g. the sandbox), skipping search. */
  merchantId?: string;
  sku?: string;
  quantity?: number;
  shipTo?: ShipTo;
  constraints?: Constraints;
  /** A merchant URL to Explore (onboard) before buying, for a shop not yet in the network. */
  exploreUrl?: string;
}

export interface Receipt {
  order_id: string;
  status: string;
  merchant_id: string;
  item: string;
  amount_charged_minor?: number;
  amount_authorized_minor: number;
  currency: string;
  charge_state?: string;
  when: string;
  note: string;
}

export type ShopResult =
  | { status: "AWAITING_APPROVAL"; shop_id: string; approve_url: string; summary: string; total_minor: number; currency: string; merchant_id: string; next: string }
  | { status: "CHOOSE_DELIVERY"; shop_id: string; options: Array<{ id: string; label?: string; amount_minor?: number }>; next: string }
  | { status: "APPROVAL_REQUIRED"; shop_id: string; approval_url?: string; reason?: string; next: string }
  | { status: "RUNNING"; shop_id: string }
  | { status: "COMPLETED"; shop_id: string; receipt: Receipt }
  | { status: "FAILED"; shop_id?: string; error: string };

interface ShopState {
  id: string;
  taskId: string;
  quote: ReadyQuote;
  merchantId: string;
  summary: string;
  approved?: { text: string; at: string };
  dispatched?: boolean; // atomic claim: dispatch at most once
  request?: ApprovedRequest;
  orderId?: string;
  stepUpToken?: string;
}

const money = (minor: number, currency: string): string => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
};

export interface AgnicManagerDeps {
  agnic: AgnicFetch;
  publicUrl: () => string;
  defaultCountry?: string;
  /** Agnic step-up / order poll cadence, injectable for tests. */
  pollMs?: number;
}

export class AgnicCommerceManager {
  private readonly shops = new Map<string, ShopState>();

  constructor(private readonly deps: AgnicManagerDeps) {}

  /** Discover + price the ask and return a summary for one human approval. */
  async shop(request: ShopRequest): Promise<ShopResult> {
    try {
      const country = request.country ?? this.deps.defaultCountry ?? "CA";
      const { merchantId, sku } = await this.resolveTarget(request, country);
      const preview: PreviewRequest = {
        merchant_id: merchantId,
        items: [{ sku, quantity: request.quantity ?? 1 }],
        ...(request.shipTo ? { ship_to: request.shipTo } : {}),
        ...(request.constraints ? { constraints: request.constraints } : {}),
      };
      let quoted = await previewOrder(this.deps.agnic, preview);

      // Physical goods need a delivery choice; pick the cheapest and re-price so the
      // user sees a single total rather than an extra round-trip.
      if (quoted.state === "choose_delivery") {
        const cheapest = [...quoted.options].sort((a, b) => (a.amount_minor ?? 0) - (b.amount_minor ?? 0))[0];
        if (!cheapest) {
          const id = this.persistPending(request.taskId, merchantId);
          return { status: "CHOOSE_DELIVERY", shop_id: id, options: quoted.options, next: "This merchant needs a delivery option; none could be auto-selected." };
        }
        quoted = await previewOrder(this.deps.agnic, { ...preview, fulfillment_option_id: cheapest.id });
      }
      if (quoted.state === "unfulfillable") return { status: "FAILED", error: "UNFULFILLABLE: this merchant can't deliver this item to the destination." };
      if (quoted.state !== "ready") {
        return { status: "FAILED", error: `PREVIEW_REFUSED (HTTP ${quoted.state === "refused" ? quoted.httpStatus : "?"}): ${quoted.state === "refused" ? JSON.stringify(quoted.code ?? quoted.blockers ?? "") : ""}` };
      }

      const id = randomUUID();
      const ceiling = quoted.amount_is_final ? "" : " (plus tax at checkout, never more than this)";
      const summary =
        `${quoted.lineItem ?? request.prompt.slice(0, 80)} — ${money(quoted.expected_amount_minor, quoted.currency)}${ceiling}. ` +
        `Merchant ${merchantId}. Pay with your vaulted card. Confirm?`;
      this.shops.set(id, { id, taskId: request.taskId, quote: quoted, merchantId, summary });
      return {
        status: "AWAITING_APPROVAL",
        shop_id: id,
        approve_url: `${this.deps.publicUrl()}/shop/${id}`,
        summary,
        total_minor: quoted.expected_amount_minor,
        currency: quoted.currency,
        merchant_id: merchantId,
        next: "Show the user the summary and the approve link. After they approve, call aisle__wait_for_purchase with this shop_id. Do NOT re-run the original request.",
      };
    } catch (err) {
      return { status: "FAILED", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The user tapped approve (records their literal confirmation — the spending mandate). */
  approve(shopId: string, confirmationText?: string): { ok: boolean; error?: string; summary?: string } {
    const s = this.shops.get(shopId);
    if (!s) return { ok: false, error: "UNKNOWN_SHOP" };
    if (!s.approved) s.approved = { text: (confirmationText ?? "Approved").slice(0, 500), at: new Date().toISOString() };
    return { ok: true, summary: s.summary };
  }

  /** After approval: place the order (once), clear any step-up, prove it, and receipt it. */
  async wait(shopId: string): Promise<ShopResult> {
    const s = this.shops.get(shopId);
    if (!s) return { status: "FAILED", error: "UNKNOWN_SHOP" };
    if (!s.approved) {
      return { status: "AWAITING_APPROVAL", shop_id: s.id, approve_url: `${this.deps.publicUrl()}/shop/${s.id}`, summary: s.summary, total_minor: s.quote.expected_amount_minor, currency: s.quote.currency, merchant_id: s.merchantId, next: "Waiting for the user to approve at the link." };
    }
    try {
      // If a step-up is pending, poll it (never re-dispatch to poll), then dispatch once more.
      if (s.stepUpToken) {
        const ok = await waitForApproval(this.deps.agnic, s.stepUpToken, { ...(this.deps.pollMs ? { pollMs: this.deps.pollMs } : {}) });
        s.stepUpToken = undefined;
        if (!ok) return { status: "FAILED", shop_id: s.id, error: "STEP_UP_NOT_APPROVED" };
        s.dispatched = false; // the step-up cleared; a fresh dispatch is expected
      }

      if (!s.orderId) {
        if (s.dispatched) return { status: "RUNNING", shop_id: s.id };
        s.dispatched = true; // atomic claim — never dispatch twice for one approval
        s.request = s.request ?? buildApprovedRequest(s.quote, { text: s.approved.text, approvedAt: s.approved.at });
        if (s.stepUpToken) s.request.approval_token = s.stepUpToken;
        const d = await dispatchOrder(this.deps.agnic, s.request);
        if (d.state === "approval_required") {
          s.stepUpToken = d.token;
          if (d.token) s.request = { ...s.request, approval_token: d.token };
          return { status: "APPROVAL_REQUIRED", shop_id: s.id, ...(d.url ? { approval_url: d.url } : {}), ...(d.reason ? { reason: d.reason } : {}), next: `A quick verification is needed (${d.reason ?? "step-up"}). Open the link, complete it, then call aisle__wait_for_purchase again. Do NOT retry the purchase.` };
        }
        if (d.state === "refused") return { status: "FAILED", shop_id: s.id, error: `REFUSED_BEFORE_CHARGE: ${JSON.stringify(d.code ?? "")}` };
        if (d.state === "reconcile") return { status: "FAILED", shop_id: s.id, error: `UNCERTAIN: reconcile before any retry (HTTP ${d.httpStatus ?? "?"}).` };
        s.orderId = d.orderId;
      }

      // Follow the order to a terminal state.
      const order = await readOrder(this.deps.agnic, s.orderId);
      const action = nextOrderAction(order);
      if (action === "poll_later") return { status: "RUNNING", shop_id: s.id };
      if (action === "human_handoff") return { status: "APPROVAL_REQUIRED", shop_id: s.id, reason: "handoff", next: "A human step (captcha / 3-D Secure / sign-in) appeared at the live checkout. Complete it, then call aisle__wait_for_purchase again. Do NOT re-place the order." };
      if (action !== "capture_once") {
        return { status: "FAILED", shop_id: s.id, error: `NOT_CONFIRMED (status=${order.status ?? "?"}, retry_action=${order.retry_action ?? "?"}). ${order.retryable == null ? "Money may have moved — check the statement." : ""}` };
      }

      const receipt: Receipt = {
        order_id: s.orderId,
        status: order.status ?? "succeeded",
        merchant_id: s.merchantId,
        item: s.quote.lineItem ?? s.request?.items.map((i) => `${i.quantity}× ${i.sku}`).join(", ") ?? "item",
        ...(order.amount_charged_minor !== undefined ? { amount_charged_minor: order.amount_charged_minor } : {}),
        amount_authorized_minor: s.quote.expected_amount_minor,
        currency: order.currency ?? s.quote.currency,
        ...(order.evidence?.charge_state ? { charge_state: order.evidence.charge_state } : {}),
        when: new Date().toISOString(),
        note: "Purchase complete. Do your setup/integration in your coding agent — Aisle's job ends at the receipt.",
      };
      this.shops.delete(s.id);
      return { status: "COMPLETED", shop_id: s.id, receipt };
    } catch (err) {
      return { status: "FAILED", shop_id: s.id, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** For the approval page. */
  pending(shopId: string): { summary: string; total_minor: number; currency: string; approved: boolean } | undefined {
    const s = this.shops.get(shopId);
    if (!s) return undefined;
    return { summary: s.summary, total_minor: s.quote.expected_amount_minor, currency: s.quote.currency, approved: s.approved !== undefined };
  }

  /** Resolve the NL ask (or explicit fields) to a concrete (merchant_id, sku). */
  private async resolveTarget(request: ShopRequest, country: string): Promise<{ merchantId: string; sku: string }> {
    if (request.merchantId && request.sku) return { merchantId: request.merchantId, sku: request.sku };
    if (request.exploreUrl) {
      const { merchantId } = await discoverMerchant(this.deps.agnic, request.exploreUrl, request.prompt);
      if (!request.sku) throw new Error("A product sku is required after exploring a merchant.");
      return { merchantId, sku: request.sku };
    }
    const products = await searchProducts(this.deps.agnic, request.prompt, country);
    const pick = products.find((p) => p.available !== false && (p.merchant?.merchant_id || p.onboard?.merchant_url));
    if (!pick) throw new Error(`NO_PRODUCT: nothing purchasable found for "${request.prompt}" in ${country}. (Agnic searches vetted Shopify shops, not the whole web.)`);
    if (pick.merchant?.merchant_id) return { merchantId: pick.merchant.merchant_id, sku: pick.sku };
    const { merchantId } = await discoverMerchant(this.deps.agnic, pick.onboard!.merchant_url!, request.prompt);
    return { merchantId, sku: pick.sku };
  }

  private persistPending(taskId: string, merchantId: string): string {
    const id = randomUUID();
    // A placeholder record so a follow-up can attach a delivery choice; minimal by design.
    this.shops.set(id, { id, taskId, merchantId, quote: { state: "ready", request: { merchant_id: merchantId, items: [] }, expected_amount_minor: 0, currency: "USD", amount_is_final: true }, summary: "" });
    return id;
  }
}
