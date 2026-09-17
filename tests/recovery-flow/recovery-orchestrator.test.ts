import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  executeRecovery,
} from "../../src/recovery-flow/recovery-orchestrator.js";

import {
  FakePurchaseExecutor,
} from "../helpers/fake-purchase-executor.js";

import type {
  PurchaseExecutor,
  PurchaseRequest,
  PurchaseResult,
} from "../../src/recovery-flow/purchase-executor.js";

import type { FailureEvent } from "../../src/event.js";

const failureEvent: FailureEvent = {
  taskId: "orchestrator-001",
  provider: "image-provider",
  toolName: "generate_image",
  toolArgs: {
    prompt: "Generate a mountain.",
  },
  errorType: "INSUFFICIENT_CREDITS",
  rawError: {
    status: 402,
    code: "insufficient_credits",
  },
  context: {
    taskId: "orchestrator-001",
    originalPrompt: "Generate a mountain.",
  },
  timestamp: new Date().toISOString(),
};

const plans = [
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

class FailedPurchaseExecutor
  implements PurchaseExecutor
{
  public callCount = 0;

  async purchase(
    request: PurchaseRequest,
  ): Promise<PurchaseResult> {
    this.callCount += 1;

    return {
      status: "FAILED",
      plan: request.plan,
      message:
        "Payment provider rejected the purchase.",
    };
  }
}

class UnknownPurchaseExecutor
  implements PurchaseExecutor
{
  public callCount = 0;

  async purchase(
    request: PurchaseRequest,
  ): Promise<PurchaseResult> {
    this.callCount += 1;

    return {
      status: "UNKNOWN",
      plan: request.plan,
      message:
        "Purchase result could not be confirmed.",
    };
  }
}

describe("executeRecovery", () => {
  it("completes the full approved recovery flow", async () => {
    const executor = new FakePurchaseExecutor();

    const result = await executeRecovery({
      event: failureEvent,

      recoveryContext: {
        currentCredits: 180,
        taskRequiredCredits: 500,
        availablePlans: plans,
      },

      selectedPlanId: "500",

      approved: true,

      purchaseExecutor: executor,

      entitlement: {
        credits: 180,
      },
    });

    // Recovery decision
    assert.equal(
      result.recommendation.requiredCredits,
      320,
    );

    assert.equal(
      result.recommendation
        .recommendation?.recommended.id,
      "500",
    );

    // Customer selection
    assert.equal(
      result.selection?.selectedPlan.id,
      "500",
    );

    assert.equal(
      result.selection?.wasRecommended,
      true,
    );

    // Approval
    assert.equal(
      result.approval?.approved,
      true,
    );

    // Purchase
    assert.equal(
      result.purchase?.status,
      "SUCCESS",
    );

    assert.equal(
      result.purchase?.plan.id,
      "500",
    );

    // Entitlement
    assert.equal(
      result.entitlement?.credits,
      680,
    );

    // Resume
    assert.equal(
      result.resume?.resumed,
      true,
    );

    assert.equal(
      result.resume?.taskId,
      "orchestrator-001",
    );

    // Final recovery session state
    assert.equal(
      result.session.status,
      "READY_TO_RESUME",
    );
  });

  it("allows the customer to choose an alternative plan", async () => {
    const executor = new FakePurchaseExecutor();

    const result = await executeRecovery({
      event: failureEvent,

      recoveryContext: {
        currentCredits: 180,
        taskRequiredCredits: 500,
        availablePlans: plans,
      },

      selectedPlanId: "1000",

      approved: true,

      purchaseExecutor: executor,

      entitlement: {
        credits: 180,
      },
    });

    // Aisle still recommends the smallest sufficient plan
    assert.equal(
      result.recommendation
        .recommendation?.recommended.id,
      "500",
    );

    // Customer chooses a different plan
    assert.equal(
      result.selection?.selectedPlan.id,
      "1000",
    );

    assert.equal(
      result.selection?.wasRecommended,
      false,
    );

    // Purchase follows customer choice
    assert.equal(
      result.purchase?.status,
      "SUCCESS",
    );

    assert.equal(
      result.purchase?.plan.id,
      "1000",
    );

    // 180 + 1000
    assert.equal(
      result.entitlement?.credits,
      1180,
    );

    assert.equal(
      result.session.status,
      "READY_TO_RESUME",
    );
  });

  it("does not purchase when the customer rejects", async () => {
    const executor = new FakePurchaseExecutor();

    const result = await executeRecovery({
      event: failureEvent,

      recoveryContext: {
        currentCredits: 180,
        taskRequiredCredits: 500,
        availablePlans: plans,
      },

      selectedPlanId: "500",

      approved: false,

      purchaseExecutor: executor,

      entitlement: {
        credits: 180,
      },
    });

    // Customer selection still happened
    assert.equal(
      result.selection?.selectedPlan.id,
      "500",
    );

    // Approval rejected
    assert.equal(
      result.approval?.approved,
      false,
    );

    // Purchase must NOT happen
    assert.equal(
      result.purchase,
      undefined,
    );

    assert.equal(
      result.entitlement,
      undefined,
    );

    assert.equal(
      result.resume,
      undefined,
    );

    // Session stops at approval
    assert.equal(
      result.session.status,
      "AWAITING_APPROVAL",
    );
  });

  it("does not require a purchase when the user already has enough credits", async () => {
    const executor = new FakePurchaseExecutor();

    const result = await executeRecovery({
      event: failureEvent,

      recoveryContext: {
        currentCredits: 600,
        taskRequiredCredits: 500,
        availablePlans: plans,
      },

      selectedPlanId: "500",

      approved: true,

      purchaseExecutor: executor,

      entitlement: {
        credits: 600,
      },
    });

    assert.equal(
      result.recommendation.requiredCredits,
      0,
    );

    assert.equal(
      result.recommendation.recommendation,
      undefined,
    );

    assert.equal(
      result.purchase,
      undefined,
    );

    assert.equal(
      result.entitlement,
      undefined,
    );

    assert.equal(
      result.resume,
      undefined,
    );

    assert.equal(
      result.session.status,
      "RECOVERY_REQUIRED",
    );
  });

  it("moves to PURCHASE_FAILED when the purchase fails", async () => {
    const executor =
      new FailedPurchaseExecutor();

    const result = await executeRecovery({
      event: failureEvent,

      recoveryContext: {
        currentCredits: 180,
        taskRequiredCredits: 500,
        availablePlans: plans,
      },

      selectedPlanId: "500",

      approved: true,

      purchaseExecutor: executor,

      entitlement: {
        credits: 180,
      },
    });

    // Approval happened
    assert.equal(
      result.approval?.approved,
      true,
    );

    // Purchase was attempted once
    assert.equal(
      executor.callCount,
      1,
    );

    // Purchase failed
    assert.equal(
      result.purchase?.status,
      "FAILED",
    );

    assert.equal(
      result.purchase?.message,
      "Payment provider rejected the purchase.",
    );

    // Entitlement MUST NOT be updated
    assert.equal(
      result.entitlement,
      undefined,
    );

    // Original task MUST NOT resume
    assert.equal(
      result.resume,
      undefined,
    );

    // Session must stop at PURCHASE_FAILED
    assert.equal(
      result.session.status,
      "PURCHASE_FAILED",
    );
  });

  it("moves to PURCHASE_UNKNOWN when the purchase result is unknown", async () => {
    const executor =
      new UnknownPurchaseExecutor();

    const result = await executeRecovery({
      event: failureEvent,

      recoveryContext: {
        currentCredits: 180,
        taskRequiredCredits: 500,
        availablePlans: plans,
      },

      selectedPlanId: "500",

      approved: true,

      purchaseExecutor: executor,

      entitlement: {
        credits: 180,
      },
    });

    // Approval happened
    assert.equal(
      result.approval?.approved,
      true,
    );

    // Purchase was attempted once
    assert.equal(
      executor.callCount,
      1,
    );

    // Result is unknown
    assert.equal(
      result.purchase?.status,
      "UNKNOWN",
    );

    assert.equal(
      result.purchase?.message,
      "Purchase result could not be confirmed.",
    );

    // UNKNOWN must not update entitlement
    assert.equal(
      result.entitlement,
      undefined,
    );

    // UNKNOWN must not resume the task
    assert.equal(
      result.resume,
      undefined,
    );

    // Session must stop safely
    assert.equal(
      result.session.status,
      "PURCHASE_UNKNOWN",
    );
  });
});