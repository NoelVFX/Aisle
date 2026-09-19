import type { IncomingHttpHeaders } from "node:http";
import type { OrderTracker } from "./order-tracker.js";
import type { MerchantOrderAdapter } from "./merchant-adapter.js";

export interface WebhookResult {
  accepted: boolean;
  duplicate?: boolean;
  orderId?: string;
  status?: string;
  reason?: string;
}

export async function handleMerchantWebhook(input: {
  rawBody: string;
  headers: IncomingHttpHeaders;
  merchantId?: string;
  adapter: MerchantOrderAdapter;
  tracker: OrderTracker;
}): Promise<WebhookResult> {
  if (input.adapter.verifyWebhook && !input.adapter.verifyWebhook(input.rawBody, input.headers)) {
    throw new Error("Invalid merchant webhook signature");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    throw new Error("Invalid webhook JSON");
  }
  const snapshot = input.adapter.normalizeWebhook(payload);
  if (!snapshot.merchantOrderId) return { accepted: false, reason: "MISSING_MERCHANT_ORDER_ID" };
  const order = await input.tracker.findByMerchantOrder(input.merchantId, snapshot.merchantOrderId);
  if (!order) return { accepted: false, reason: "ORDER_NOT_LINKED" };
  const merchantEventId = headerValue(input.headers, "x-shopify-webhook-id") ?? headerValue(input.headers, "x-event-id");
  const before = await input.tracker.eventsFor(order.id, 1);
  const updated = await input.tracker.ingestMerchantSnapshot(order.id, snapshot, "merchant_webhook", merchantEventId);
  const after = await input.tracker.eventsFor(order.id, 1);
  return { accepted: true, duplicate: Boolean(merchantEventId && before[0]?.merchantEventId === merchantEventId && after[0]?.merchantEventId === merchantEventId), orderId: updated.id, status: updated.status };
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}
