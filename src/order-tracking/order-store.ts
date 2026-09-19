import type { Order } from "./order.js";

export interface OrderStore {
  create(order: Order): Promise<void>;

  get(orderId: string): Promise<Order | undefined>;

  update(order: Order): Promise<void>;

  listByTask(taskId: string): Promise<Order[]>;
}

export class InMemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, Order>();

  async create(order: Order): Promise<void> {
    if (this.orders.has(order.id)) {
      throw new Error(`Order already exists: ${order.id}`);
    }

    this.orders.set(order.id, order);
  }

  async get(orderId: string): Promise<Order | undefined> {
    return this.orders.get(orderId);
  }

  async update(order: Order): Promise<void> {
    if (!this.orders.has(order.id)) {
      throw new Error(`Order not found: ${order.id}`);
    }

    this.orders.set(order.id, order);
  }

  async listByTask(taskId: string): Promise<Order[]> {
    return [...this.orders.values()].filter(
      (order) => order.taskId === taskId,
    );
  }
}