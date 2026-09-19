import { describe, expect, it } from "vitest";

import {
  InMemoryOrderStore,
} from "../src/order-tracking/order-store.js";

import {
  OrderEventBus,
} from "../src/order-tracking/order-events.js";

import {
  OrderTracker,
} from "../src/order-tracking/order-tracker.js";
import {
  OrderWaiter,
} from "../src/order-tracking/order-waiter.js";

import type {
  OrderEvent,
} from "../src/order-tracking/order-events.js";

describe("Order Tracking", () => {
  it("updates an order and emits an event", async () => {
    const store = new InMemoryOrderStore();
    const events = new OrderEventBus();

    const tracker = new OrderTracker(
      store,
      events,
    );

    await store.create({
      id: "order_001",
      agentId: "agent_001",
      taskId: "task_001",
      vendor: "demo",
      status: "PROCESSING",
      amount: 99.99,
      currency: "USD",
      trackingNumber: "TRACK123",
      carrier: "demo-carrier",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let receivedEvent: OrderEvent | undefined;

    events.subscribe((event) => {
      receivedEvent = event;
    });

    const updated = await tracker.updateStatus(
      "order_001",
      "SHIPPED",
    );

    expect(updated.status).toBe("SHIPPED");

    expect(receivedEvent).toBeDefined();
    expect(receivedEvent?.type).toBe(
      "ORDER_SHIPPED",
    );

    expect(receivedEvent?.orderId).toBe(
      "order_001",
    );

    expect(receivedEvent?.agentId).toBe(
      "agent_001",
    );

    expect(receivedEvent?.taskId).toBe(
      "task_001",
    );
  });

  it("waits for a real-time order status change", async () => {
    const store = new InMemoryOrderStore();
    const events = new OrderEventBus();
    const tracker = new OrderTracker(store, events);
    const waiter = new OrderWaiter(events);

    await store.create({
      id: "order_002",
      agentId: "agent_001",
      taskId: "task_002",
      vendor: "demo",
      status: "PROCESSING",
      amount: 49.99,
      currency: "USD",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const waitingAgent = waiter.waitForOrder("order_002");

    setTimeout(() => {
      void tracker.updateStatus("order_002", "SHIPPED");
    }, 50);

    const event = await waitingAgent;

    expect(event.type).toBe("ORDER_SHIPPED");
    expect(event.orderId).toBe("order_002");
    expect(event.status).toBe("SHIPPED");
  });

});