import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { createRecoveryDecision } from "../../src/recovery-flow/recovery.js";
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
  taskId: "task-001",
  provider: "image-provider",
  toolName: "generate_image",
  toolArgs: {},
  errorType: "INSUFFICIENT_CREDITS",
  rawError: {
    status: 402,
    code: "insufficient_credits",
  },
  context: {
    taskId: "task-001",
    originalPrompt: "Generate an image",
  },
  timestamp: new Date().toISOString(),
};

describe("createRecoveryDecision", () => {
  it("calculates the required credits and recommends the smallest sufficient plan", () => {
    const result = createRecoveryDecision(failureEvent, {
      currentCredits: 180,
      taskRequiredCredits: 500,
      availablePlans: plans,
    });

    assert.equal(result.requiredCredits, 320);
    assert.equal(result.recommendation?.recommended.id, "500");
  });

  it("returns larger plans as alternatives", () => {
    const result = createRecoveryDecision(failureEvent, {
      currentCredits: 180,
      taskRequiredCredits: 500,
      availablePlans: plans,
    });

    assert.deepEqual(
      result.recommendation?.alternatives.map((plan) => plan.id),
      ["1000"],
    );
  });

  it("does not require a purchase when the user already has enough credits", () => {
    const result = createRecoveryDecision(failureEvent, {
      currentCredits: 600,
      taskRequiredCredits: 500,
      availablePlans: plans,
    });

    assert.equal(result.requiredCredits, 0);
    assert.equal(result.recommendation, undefined);
  });

  it("preserves the original failure event", () => {
    const result = createRecoveryDecision(failureEvent, {
      currentCredits: 180,
      taskRequiredCredits: 500,
      availablePlans: plans,
    });

    assert.equal(result.event.taskId, "task-001");
    assert.equal(result.event.provider, "image-provider");
    assert.equal(result.event.toolName, "generate_image");
    assert.equal(result.event.errorType, "INSUFFICIENT_CREDITS");
  });

  it("throws when no available plan can satisfy the requirement", () => {
    assert.throws(() =>
      createRecoveryDecision(failureEvent, {
        currentCredits: 0,
        taskRequiredCredits: 5000,
        availablePlans: plans,
      }),
    );
  });
});