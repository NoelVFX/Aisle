import type { FailureEvent } from "../event.js";
import type { WakeUpHandler } from "../wakeup-manager.js";

import {
  createRecoveryDecision,
  type RecoveryContext,
  type RecoveryResult,
} from "./recovery.js";

export class RecoveryHandler implements WakeUpHandler {
  private readonly recoveryContext: RecoveryContext;

  constructor(recoveryContext: RecoveryContext) {
    this.recoveryContext = recoveryContext;
  }

  async wake(event: FailureEvent): Promise<void> {
    const result = this.createDecision(event);

    this.printRecoveryDecision(result);
  }

  /**
   * Create a recovery decision for a failed task.
   *
   * This method is intentionally separate from payment execution.
   */
  createDecision(event: FailureEvent): RecoveryResult {
    return createRecoveryDecision(
      event,
      this.recoveryContext,
    );
  }

  private printRecoveryDecision(
    result: RecoveryResult,
  ): void {
    console.log("[Aisle] Recovery decision created.");

    console.log(
      `[Aisle] Additional credits required: ${result.requiredCredits}`,
    );

    if (!result.recommendation) {
      console.log(
        "[Aisle] No purchase required. Current credits are sufficient.",
      );
      return;
    }

    const { recommended, alternatives } =
      result.recommendation;

    console.log(
      `[Aisle] Recommended plan: ${recommended.name} - ${recommended.credits} credits - ${recommended.price} ${recommended.currency}`,
    );

    if (alternatives.length === 0) {
      console.log(
        "[Aisle] No alternative plans available.",
      );
      return;
    }

    console.log("[Aisle] Alternative plans:");

    for (const plan of alternatives) {
      console.log(
        `  - ${plan.name} - ${plan.credits} credits - ${plan.price} ${plan.currency}`,
      );
    }
  }
}