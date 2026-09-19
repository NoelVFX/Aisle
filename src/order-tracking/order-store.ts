import type { Order, OrderEventRecord } from "./order.js";

export interface OrderStore {
  init?(): Promise<void>;
  create(order: Order): Promise<void>;
  get(orderId: string): Promise<Order | undefined>;
  update(order: Order): Promise<void>;
  listByTask(taskId: string): Promise<Order[]>;
  findByMerchantOrder(merchantId: string | undefined, merchantOrderId: string): Promise<Order | undefined>;
  listActive(): Promise<Order[]>;
  listEvents(orderId: string, limit?: number): Promise<OrderEventRecord[]>;
  recordEvent?(event: OrderEventRecord): Promise<boolean>;
}

export class InMemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, Order>();
  private readonly events = new Map<string, OrderEventRecord>();

  async create(order: Order): Promise<void> {
    if (this.orders.has(order.id)) throw new Error(`Order already exists: ${order.id}`);
    this.orders.set(order.id, structuredClone(order));
  }

  async get(orderId: string): Promise<Order | undefined> {
    const order = this.orders.get(orderId);
    return order ? structuredClone(order) : undefined;
  }

  async update(order: Order): Promise<void> {
    if (!this.orders.has(order.id)) throw new Error(`Order not found: ${order.id}`);
    this.orders.set(order.id, structuredClone(order));
  }

  async listByTask(taskId: string): Promise<Order[]> {
    return [...this.orders.values()].filter((order) => order.taskId === taskId).map((order) => structuredClone(order));
  }

  async findByMerchantOrder(merchantId: string | undefined, merchantOrderId: string): Promise<Order | undefined> {
    const order = [...this.orders.values()].find((item) => item.merchantOrderId === merchantOrderId && (!merchantId || item.merchantId === merchantId));
    return order ? structuredClone(order) : undefined;
  }

  async listActive(): Promise<Order[]> {
    return [...this.orders.values()].filter((order) => !["DELIVERED", "CANCELLED", "EXCEPTION"].includes(order.status)).map((order) => structuredClone(order));
  }

  async listEvents(orderId: string, limit = 100): Promise<OrderEventRecord[]> {
    return [...this.events.values()].filter((event) => event.orderId === orderId).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit).map((event) => structuredClone(event));
  }

  async recordEvent(event: OrderEventRecord): Promise<boolean> {
    if (this.events.has(event.id)) return false;
    if (event.merchantEventId && [...this.events.values()].some((item) => item.merchantEventId === event.merchantEventId)) return false;
    this.events.set(event.id, structuredClone(event));
    return true;
  }
}

import { Pool, type PoolConfig, type QueryResultRow } from "pg";

const toOrder = (row: QueryResultRow): Order => ({
  id: String(row["id"]),
  agentId: String(row["agent_id"]),
  taskId: String(row["task_id"]),
  vendor: String(row["vendor"]),
  ...(row["merchant_id"] ? { merchantId: String(row["merchant_id"]) } : {}),
  ...(row["merchant_order_id"] ? { merchantOrderId: String(row["merchant_order_id"]) } : {}),
  ...(row["merchant_order_number"] ? { merchantOrderNumber: String(row["merchant_order_number"]) } : {}),
  status: String(row["status"]) as Order["status"],
  ...(row["raw_status"] ? { rawStatus: String(row["raw_status"]) } : {}),
  amount: Number(row["amount"]),
  currency: String(row["currency"]),
  ...(row["tracking_number"] ? { trackingNumber: String(row["tracking_number"]) } : {}),
  ...(row["carrier"] ? { carrier: String(row["carrier"]) } : {}),
  ...(row["tracking_url"] ? { trackingUrl: String(row["tracking_url"]) } : {}),
  ...(row["estimated_delivery"] ? { estimatedDelivery: new Date(row["estimated_delivery"]).toISOString() } : {}),
  ...(row["last_synced_at"] ? { lastSyncedAt: new Date(row["last_synced_at"]).toISOString() } : {}),
  createdAt: new Date(row["created_at"]).toISOString(),
  updatedAt: new Date(row["updated_at"]).toISOString(),
});

export class PostgresOrderStore implements OrderStore {
  readonly pool: Pool;

  constructor(config: PoolConfig | string) {
    this.pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS aisle_orders (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        vendor TEXT NOT NULL,
        merchant_id TEXT,
        merchant_order_id TEXT,
        merchant_order_number TEXT,
        status TEXT NOT NULL,
        raw_status TEXT,
        amount NUMERIC(18, 2) NOT NULL,
        currency TEXT NOT NULL,
        tracking_number TEXT,
        carrier TEXT,
        tracking_url TEXT,
        estimated_delivery TIMESTAMPTZ,
        last_synced_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS aisle_orders_task_idx ON aisle_orders(task_id);
      CREATE INDEX IF NOT EXISTS aisle_orders_merchant_idx ON aisle_orders(merchant_id, merchant_order_id);
      CREATE TABLE IF NOT EXISTS aisle_order_events (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES aisle_orders(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        merchant_event_id TEXT UNIQUE,
        status TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        order_snapshot JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS aisle_order_events_order_idx ON aisle_order_events(order_id, timestamp);
    `);
  }

  async create(order: Order): Promise<void> {
    await this.pool.query(`INSERT INTO aisle_orders (id, agent_id, task_id, vendor, merchant_id, merchant_order_id, merchant_order_number, status, raw_status, amount, currency, tracking_number, carrier, tracking_url, estimated_delivery, last_synced_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`, [
      order.id, order.agentId, order.taskId, order.vendor, order.merchantId ?? null, order.merchantOrderId ?? null, order.merchantOrderNumber ?? null, order.status, order.rawStatus ?? null, order.amount, order.currency, order.trackingNumber ?? null, order.carrier ?? null, order.trackingUrl ?? null, order.estimatedDelivery ?? null, order.lastSyncedAt ?? null, order.createdAt, order.updatedAt,
    ]);
  }

  async get(orderId: string): Promise<Order | undefined> {
    const result = await this.pool.query("SELECT * FROM aisle_orders WHERE id = $1", [orderId]);
    return result.rows[0] ? toOrder(result.rows[0]) : undefined;
  }

  async update(order: Order): Promise<void> {
    const result = await this.pool.query(`UPDATE aisle_orders SET merchant_id=$2, merchant_order_id=$3, merchant_order_number=$4, status=$5, raw_status=$6, amount=$7, currency=$8, tracking_number=$9, carrier=$10, tracking_url=$11, estimated_delivery=$12, last_synced_at=$13, updated_at=$14 WHERE id=$1`, [
      order.id, order.merchantId ?? null, order.merchantOrderId ?? null, order.merchantOrderNumber ?? null, order.status, order.rawStatus ?? null, order.amount, order.currency, order.trackingNumber ?? null, order.carrier ?? null, order.trackingUrl ?? null, order.estimatedDelivery ?? null, order.lastSyncedAt ?? null, order.updatedAt,
    ]);
    if (result.rowCount !== 1) throw new Error(`Order not found: ${order.id}`);
  }

  async listByTask(taskId: string): Promise<Order[]> {
    const result = await this.pool.query("SELECT * FROM aisle_orders WHERE task_id = $1 ORDER BY created_at DESC", [taskId]);
    return result.rows.map(toOrder);
  }

  async findByMerchantOrder(merchantId: string | undefined, merchantOrderId: string): Promise<Order | undefined> {
    const result = await this.pool.query("SELECT * FROM aisle_orders WHERE merchant_order_id = $1 AND ($2::text IS NULL OR merchant_id = $2) LIMIT 1", [merchantOrderId, merchantId ?? null]);
    return result.rows[0] ? toOrder(result.rows[0]) : undefined;
  }

  async listActive(): Promise<Order[]> {
    const result = await this.pool.query("SELECT * FROM aisle_orders WHERE status NOT IN ('DELIVERED','CANCELLED','EXCEPTION') ORDER BY updated_at ASC");
    return result.rows.map(toOrder);
  }

  async listEvents(orderId: string, limit = 100): Promise<OrderEventRecord[]> {
    const result = await this.pool.query("SELECT id, order_id, type, source, merchant_event_id, status, timestamp, order_snapshot FROM aisle_order_events WHERE order_id = $1 ORDER BY timestamp DESC LIMIT $2", [orderId, limit]);
    return result.rows.reverse().map((row) => ({
      id: String(row["id"]), orderId: String(row["order_id"]), agentId: String((row["order_snapshot"] as Record<string, unknown>)["agentId"]), taskId: String((row["order_snapshot"] as Record<string, unknown>)["taskId"]), type: String(row["type"]), source: row["source"], ...(row["merchant_event_id"] ? { merchantEventId: String(row["merchant_event_id"]) } : {}), status: row["status"], timestamp: new Date(row["timestamp"]).toISOString(), order: row["order_snapshot"] as Order,
    }));
  }

  async recordEvent(event: OrderEventRecord): Promise<boolean> {
    const result = await this.pool.query(`INSERT INTO aisle_order_events (id, order_id, type, source, merchant_event_id, status, timestamp, order_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [event.id, event.orderId, event.type, event.source, event.merchantEventId ?? null, event.status, event.timestamp, JSON.stringify(event.order)]);
    return result.rowCount === 1;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
