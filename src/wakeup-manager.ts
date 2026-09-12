import type { FailureEvent } from "./event.js";

export interface WakeUpHandler {
  wake(event: FailureEvent): Promise<void>;
}

export class WakeUpManager {
  private readonly handler: WakeUpHandler;

  /**
   * Stores recovery attempts that have already triggered a wake-up.
   *
   * The key is scoped to a task, tool, and failure type so that one
   * recoverable failure cannot repeatedly trigger the recovery agent.
   */
  private readonly awakenedFailures = new Set<string>();

  constructor(handler: WakeUpHandler) {
    this.handler = handler;
  }

  async handle(event: FailureEvent): Promise<void> {
    if (!this.shouldWake(event)) {
      console.log(
        `[Aisle] Ignoring non-recoverable failure: ${event.errorType}`,
      );
      return;
    }

    const wakeKey = this.createWakeKey(event);

    if (this.awakenedFailures.has(wakeKey)) {
      console.log(
        `[Aisle] Wake-up already triggered for this failure: ${wakeKey}`,
      );
      return;
    }

    this.awakenedFailures.add(wakeKey);

    console.log(
      `[Aisle] Recoverable payment failure detected: ${event.errorType}`,
    );

    try {
      await this.handler.wake(event);
    } catch (error) {
      /*
       * The recovery handler failed before completing.
       *
       * Remove the key so the system can retry the wake-up instead of
       * permanently suppressing recovery.
       */
      this.awakenedFailures.delete(wakeKey);
      throw error;
    }
  }

  private shouldWake(event: FailureEvent): boolean {
    return (
      event.errorType === "PAYMENT_REQUIRED" ||
      event.errorType === "QUOTA_EXCEEDED" ||
      event.errorType === "INSUFFICIENT_CREDITS" ||
      event.errorType === "PLAN_REQUIRED"
    );
  }

  private createWakeKey(event: FailureEvent): string {
    return [
      event.taskId,
      event.provider,
      event.toolName,
      event.errorType,
    ].join(":");
  }
}