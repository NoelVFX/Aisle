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
