export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "PROCESSING"
  | "SHIPPED"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "CANCELLED"
  | "EXCEPTION";

export type OrderEventSource = "merchant_webhook" | "poller" | "manual" | "agnic";

export interface Order {
  id: string;
  agentId: string;
  taskId: string;
  vendor: string;
  merchantId?: string;
  merchantOrderId?: string;
  merchantOrderNumber?: string;
  status: OrderStatus;
  rawStatus?: string;
  amount: number;
  currency: string;
  trackingNumber?: string;
  carrier?: string;
  trackingUrl?: string;
  estimatedDelivery?: string;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderEventRecord {
  id: string;
  orderId: string;
  agentId: string;
  taskId: string;
  type: string;
  source: OrderEventSource;
  merchantEventId?: string;
  status: OrderStatus;
  timestamp: string;
  order: Order;
}

export interface MerchantOrderSnapshot {
  merchantOrderId: string;
  merchantOrderNumber?: string;
  status: OrderStatus;
  rawStatus?: string;
  trackingNumber?: string;
  carrier?: string;
  trackingUrl?: string;
  estimatedDelivery?: string;
  updatedAt?: string;
}
