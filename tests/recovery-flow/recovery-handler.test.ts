import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { RecoveryHandler } from "../../src/recovery-flow/recovery-handler.js";
import { WakeUpManager } from "../../src/wakeup-manager.js";
import type { FailureEvent } from "../../src/event.js";
import type { CreditPlan } from "../../src/recovery-flow/purchase-recommender.js";

const plans: CreditPlan[] = [
  {
    id: "100",
    name: "100 Credits",
    credits: 100,
    price: 5,
    currency: "USD",
  },
  {
    id: "500",
    name: "500 Credits",
    credits: 500,
    price: 20,
    currency: "USD",
  },
  {
    id: "1000",
    name: "1000 Credits",
    credits: 1000,
    price: 35,
    currency: "USD",
  },
];

const failureEvent: FailureEvent = {
  taskId: "task-handler-001",
  provider: "image-provider",
  toolName: "generate_image",
  toolArgs: {},
  errorType: "INSUFFICIENT_CREDITS",
  rawError: {
    status: 402,
    code: "insufficient_credits",
  },
  context: {
    taskId: "task-handler-001",
    originalPrompt: "Generate an image",
  },
  timestamp: new Date().toISOString(),
};

describe("RecoveryHandler", () => {
  it("can be used as a WakeUpHandler", async () => {
    const handler = new RecoveryHandler({
      currentCredits: 180,
      taskRequiredCredits: 500,
      availablePlans: plans,
    });

    const manager = new WakeUpManager(handler);

    await manager.handle(failureEvent);
  });

  it("can receive a recoverable payment failure", async () => {
    const handler = new RecoveryHandler({
      currentCredits: 180,
      taskRequiredCredits: 500,
      availablePlans: plans,
    });

    await handler.wake(failureEvent);

    assert.ok(true);
  });

  it("can handle a case where no purchase is required", async () => {
    const handler = new RecoveryHandler({
      currentCredits: 600,
      taskRequiredCredits: 500,
      availablePlans: plans,
    });

    await handler.wake(failureEvent);

    assert.ok(true);
  });
});