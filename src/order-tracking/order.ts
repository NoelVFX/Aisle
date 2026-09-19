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

export interface Order {
  id: string;

  agentId: string;
  taskId: string;

  vendor: string;

  status: OrderStatus;

  amount: number;
  currency: string;

  trackingNumber?: string;
  carrier?: string;

  estimatedDelivery?: string;

  createdAt: string;
  updatedAt: string;
}
