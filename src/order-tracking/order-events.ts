import type { Order, OrderEventRecord, OrderEventSource, OrderStatus } from "./order.js";

export type OrderEventType =
  | "ORDER_CREATED"
  | "ORDER_CONFIRMED"
  | "ORDER_PROCESSING"
  | "ORDER_SHIPPED"
  | "ORDER_IN_TRANSIT"
  | "ORDER_OUT_FOR_DELIVERY"
  | "ORDER_DELIVERED"
  | "ORDER_CANCELLED"
  | "ORDER_EXCEPTION"
  | "ORDER_UPDATED";

export interface OrderEvent extends OrderEventRecord {
  type: OrderEventType;
}

export type OrderEventListener = (event: OrderEvent) => void;

export class OrderEventBus {
  private readonly listeners = new Set<OrderEventListener>();

  subscribe(listener: OrderEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: OrderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export const eventTypeForStatus = (status: OrderStatus): OrderEventType => {
  const names: Record<OrderStatus, OrderEventType> = {
    PENDING: "ORDER_CREATED",
    CONFIRMED: "ORDER_CONFIRMED",
    PROCESSING: "ORDER_PROCESSING",
    SHIPPED: "ORDER_SHIPPED",
    IN_TRANSIT: "ORDER_IN_TRANSIT",
    OUT_FOR_DELIVERY: "ORDER_OUT_FOR_DELIVERY",
    DELIVERED: "ORDER_DELIVERED",
    CANCELLED: "ORDER_CANCELLED",
    EXCEPTION: "ORDER_EXCEPTION",
  };
  return names[status];
};

export const makeOrderEvent = (input: {
  order: Order;
  type?: OrderEventType;
  source: OrderEventSource;
  merchantEventId?: string;
  timestamp?: string;
}): OrderEvent => ({
  id: crypto.randomUUID(),
  orderId: input.order.id,
  agentId: input.order.agentId,
  taskId: input.order.taskId,
  type: input.type ?? eventTypeForStatus(input.order.status),
  source: input.source,
  ...(input.merchantEventId ? { merchantEventId: input.merchantEventId } : {}),
  status: input.order.status,
  timestamp: input.timestamp ?? input.order.updatedAt,
  order: input.order,
});
