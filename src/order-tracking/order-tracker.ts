import { randomUUID } from "node:crypto";
import type { MerchantOrderSnapshot, Order, OrderEventRecord, OrderEventSource, OrderStatus } from "./order.js";
import { OrderEventBus, eventTypeForStatus, makeOrderEvent, type OrderEvent, type OrderEventType } from "./order-events.js";
import type { OrderStore } from "./order-store.js";

export class OrderTracker {
  constructor(
    private readonly store: OrderStore,
    private readonly events: OrderEventBus,
  ) {}

  async create(order: Order, source: OrderEventSource = "manual", merchantEventId?: string): Promise<Order> {
    await this.store.create(order);
    await this.publish(makeOrderEvent({ order, source, merchantEventId }));
    return order;
  }

  async get(orderId: string): Promise<Order | undefined> {
    return this.store.get(orderId);
  }

  async listByTask(taskId: string): Promise<Order[]> {
    return this.store.listByTask(taskId);
  }

  async findByMerchantOrder(merchantId: string | undefined, merchantOrderId: string): Promise<Order | undefined> {
    return this.store.findByMerchantOrder(merchantId, merchantOrderId);
  }

  async activeOrders(): Promise<Order[]> {
    return this.store.listActive();
  }

  async eventsFor(orderId: string, limit = 100): Promise<OrderEventRecord[]> {
    return this.store.listEvents(orderId, limit);
  }

  async updateStatus(orderId: string, status: OrderStatus, source: OrderEventSource = "manual", merchantEventId?: string): Promise<Order> {
    const order = await this.store.get(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.status === status && !merchantEventId) return order;
    return this.update(order, { status, source, merchantEventId });
  }

  async ingestMerchantSnapshot(orderId: string, snapshot: MerchantOrderSnapshot, source: OrderEventSource = "merchant_webhook", merchantEventId?: string): Promise<Order> {
    const order = await this.store.get(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    return this.update(order, {
      status: snapshot.status,
      rawStatus: snapshot.rawStatus,
      merchantOrderId: snapshot.merchantOrderId,
      merchantOrderNumber: snapshot.merchantOrderNumber,
      trackingNumber: snapshot.trackingNumber,
      carrier: snapshot.carrier,
      trackingUrl: snapshot.trackingUrl,
      estimatedDelivery: snapshot.estimatedDelivery,
      lastSyncedAt: snapshot.updatedAt ?? new Date().toISOString(),
      source,
      merchantEventId,
    });
  }

  private async update(order: Order, change: Partial<Order> & { source: OrderEventSource; merchantEventId?: string }): Promise<Order> {
    const updatedOrder: Order = {
      ...order,
      ...change,
      updatedAt: new Date().toISOString(),
    };
    delete (updatedOrder as Partial<Order> & { source?: unknown }).source;
    delete (updatedOrder as Partial<Order> & { merchantEventId?: unknown }).merchantEventId;
    await this.store.update(updatedOrder);
    await this.publish(makeOrderEvent({ order: updatedOrder, source: change.source, merchantEventId: change.merchantEventId, type: eventTypeForStatus(updatedOrder.status) }));
    return updatedOrder;
  }

  private async publish(event: OrderEvent): Promise<void> {
    if (this.store.recordEvent && !(await this.store.recordEvent(event))) return;
    this.events.publish(event);
  }
}

export const orderFromAgnicReceipt = (input: {
  receipt: { order_id: string; merchant_id: string; amount_authorized_minor: number; amount_charged_minor?: number; currency: string; status: string };
  taskId: string;
}): Order => {
  const now = new Date().toISOString();
  return {
    id: `order_${randomUUID()}`,
    agentId: "local-agent",
    taskId: input.taskId,
    vendor: input.receipt.merchant_id,
    merchantId: input.receipt.merchant_id,
    merchantOrderId: input.receipt.order_id,
    status: "CONFIRMED",
    rawStatus: input.receipt.status,
    amount: (input.receipt.amount_charged_minor ?? input.receipt.amount_authorized_minor) / 100,
    currency: input.receipt.currency,
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
  };
};
