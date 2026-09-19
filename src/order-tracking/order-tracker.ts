import { randomUUID } from "node:crypto";

import type { Order, OrderStatus } from "./order.js";
import type { OrderStore } from "./order-store.js";
import {
  OrderEventBus,
  type OrderEventType,
} from "./order-events.js";

const EVENT_FOR_STATUS: Partial<
  Record<OrderStatus, OrderEventType>
> = {
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

export class OrderTracker {
  constructor(
    private readonly store: OrderStore,
    private readonly events: OrderEventBus,
  ) {}

  async create(order: Order): Promise<Order> {
    await this.store.create(order);

    const eventType = EVENT_FOR_STATUS[order.status];

    if (eventType !== undefined) {
      this.events.publish({
        id: randomUUID(),
        type: eventType,
        orderId: order.id,
        agentId: order.agentId,
        taskId: order.taskId,
        status: order.status,
        timestamp: order.createdAt,
        order,
      });
    }

    return order;
  }

  async get(orderId: string): Promise<Order | undefined> {
    return this.store.get(orderId);
  }

  async updateStatus(
    orderId: string,
    status: OrderStatus,
  ): Promise<Order> {
    const order = await this.store.get(orderId);

    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    if (order.status === status) {
      return order;
    }

    const updatedOrder: Order = {
      ...order,
      status,
      updatedAt: new Date().toISOString(),
    };

    await this.store.update(updatedOrder);

    const eventType = EVENT_FOR_STATUS[status];

    if (eventType !== undefined) {
      this.events.publish({
        id: randomUUID(),
        type: eventType,
        orderId: updatedOrder.id,
        agentId: updatedOrder.agentId,
        taskId: updatedOrder.taskId,
        status: updatedOrder.status,
        timestamp: updatedOrder.updatedAt,
        order: updatedOrder,
      });
    }

    return updatedOrder;
  }
}