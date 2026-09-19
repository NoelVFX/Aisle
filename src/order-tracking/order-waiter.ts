import type { OrderEvent } from "./order-events.js";
import {
  OrderEventBus,
} from "./order-events.js";

export class OrderWaiter {
  constructor(
    private readonly events: OrderEventBus,
  ) {}

  waitForOrder(
    orderId: string,
    timeoutMs = 60_000,
  ): Promise<OrderEvent> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const unsubscribe = this.events.subscribe(
        (event) => {
          if (
            event.orderId !== orderId ||
            settled
          ) {
            return;
          }

          settled = true;
          unsubscribe();
          clearTimeout(timeout);

          resolve(event);
        },
      );

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        unsubscribe();

        reject(
          new Error(
            `Timed out waiting for order: ${orderId}`,
          ),
        );
      }, timeoutMs);
    });
  }
}