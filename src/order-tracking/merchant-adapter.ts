import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { MerchantOrderSnapshot, OrderStatus } from "./order.js";

export interface MerchantOrderAdapter {
  readonly provider: string;
  normalizeWebhook(payload: unknown): MerchantOrderSnapshot;
  verifyWebhook?(rawBody: string, headers: IncomingHttpHeaders): boolean;
  fetchOrder?(merchantOrderId: string): Promise<MerchantOrderSnapshot>;
}

const asRecord = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

export class ShopifyOrderAdapter implements MerchantOrderAdapter {
  readonly provider = "shopify";

  constructor(private readonly secret?: string, private readonly polling?: { adminUrl: string; accessToken: string; apiVersion?: string }) {}

  async fetchOrder(merchantOrderId: string): Promise<MerchantOrderSnapshot> {
    if (!this.polling) throw new Error("Shopify polling is not configured");
    const version = this.polling.apiVersion ?? "2025-01";
    const response = await fetch(`${this.polling.adminUrl.replace(/\/$/, "")}/admin/api/${version}/orders/${encodeURIComponent(merchantOrderId)}.json`, {
      headers: { "X-Shopify-Access-Token": this.polling.accessToken, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Shopify order HTTP ${response.status}`);
    const data = await response.json() as { order?: unknown };
    return this.normalizeWebhook(data.order ?? data);
  }

  verifyWebhook(rawBody: string, headers: IncomingHttpHeaders): boolean {
    if (!this.secret) return false;
    const supplied = text(headers["x-shopify-hmac-sha256"]);
    if (!supplied) return false;
    const expected = createHmac("sha256", this.secret).update(rawBody, "utf8").digest("base64");
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  normalizeWebhook(payload: unknown): MerchantOrderSnapshot {
    const root = asRecord(payload);
    const fulfillments = Array.isArray(root["fulfillments"]) ? root["fulfillments"].map(asRecord) : [];
    const fulfillment = fulfillments[0] ?? {};
    const tracking = Array.isArray(fulfillment["tracking_info"]) ? asRecord(fulfillment["tracking_info"][0]) : asRecord(fulfillment["tracking_info"]);
    const rawStatus = text(fulfillment["shipment_status"]) ?? text(fulfillment["status"]) ?? text(root["fulfillment_status"]) ?? text(root["financial_status"]) ?? "unknown";
    const status = normalizeShopifyStatus(rawStatus, text(root["cancelled_at"]));
    return {
      merchantOrderId: String(root["id"] ?? root["admin_graphql_api_id"] ?? ""),
      ...(text(root["name"]) ? { merchantOrderNumber: text(root["name"]) } : {}),
      status,
      rawStatus,
      ...(text(tracking["number"]) ? { trackingNumber: text(tracking["number"]) } : {}),
      ...(text(tracking["company"]) ? { carrier: text(tracking["company"]) } : {}),
      ...(text(tracking["url"]) ? { trackingUrl: text(tracking["url"]) } : {}),
      ...(text(root["updated_at"]) ? { updatedAt: text(root["updated_at"]) } : {}),
    };
  }
}

export function normalizeShopifyStatus(raw: string, cancelledAt?: string): OrderStatus {
  if (cancelledAt || /cancel/i.test(raw)) return "CANCELLED";
  if (/delivered/i.test(raw)) return "DELIVERED";
  if (/out_for_delivery|out for delivery/i.test(raw)) return "OUT_FOR_DELIVERY";
  if (/in_transit|in transit/i.test(raw)) return "IN_TRANSIT";
  if (/transit|shipped|fulfilled/i.test(raw)) return "SHIPPED";
  if (/partial|processing|open|paid/i.test(raw)) return "PROCESSING";
  if (/failure|exception|error/i.test(raw)) return "EXCEPTION";
  return "CONFIRMED";
}
