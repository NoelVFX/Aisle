import type { Order, OrderStatus } from "./order.js";

export type OrderEventType =
  | "ORDER_CREATED"
  | "ORDER_CONFIRMED"
  | "ORDER_PROCESSING"
  | "ORDER_SHIPPED"
  | "ORDER_IN_TRANSIT"
  | "ORDER_OUT_FOR_DELIVERY"
  | "ORDER_DELIVERED"
  | "ORDER_CANCELLED"
  | "ORDER_EXCEPTION";

export interface OrderEvent {
  id: string;
  type: OrderEventType;

  orderId: string;

  agentId: string;
  taskId: string;

  status: OrderStatus;

  timestamp: string;

  order: Order;
}

export type OrderEventListener = (
  event: OrderEvent,
) => void;

export class OrderEventBus {
  private readonly listeners =
    new Set<OrderEventListener>();

  subscribe(
    listener: OrderEventListener,
  ): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: OrderEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}