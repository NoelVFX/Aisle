import type { MerchantOrderAdapter } from "./merchant-adapter.js";
import type { Order } from "./order.js";
import type { OrderTracker } from "./order-tracker.js";

export class OrderPollingService {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly tracker: OrderTracker,
    private readonly adapters: Map<string, MerchantOrderAdapter>,
    private readonly intervalMs = 30 * 60_000,
    private readonly log: (message: string) => void = () => {},
  ) {}

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
    void this.poll();
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const order of await this.tracker.activeOrders()) {
        const adapter = this.adapters.get(order.vendor) ?? this.adapters.get(order.merchantId ?? "");
        if (!adapter?.fetchOrder || !order.merchantOrderId) continue;
        try {
          const snapshot = await adapter.fetchOrder(order.merchantOrderId);
          await this.tracker.ingestMerchantSnapshot(order.id, snapshot, "poller");
        } catch (error) {
          this.log(`order polling failed for ${order.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export const activeOrder = (order: Order): boolean => !["DELIVERED", "CANCELLED", "EXCEPTION"].includes(order.status);
