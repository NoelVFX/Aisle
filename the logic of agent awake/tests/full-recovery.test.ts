import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ErrorInterceptor } from "../src/interceptor.js";
import { WakeUpManager } from "../src/wakeup-manager.js";
import { RecoveryHandler } from "../src/recovery-handler.js";
import { selectPurchasePlan } from "../src/customer-selection.js";
import {
  createApprovalRequest,
  recordApproval,
} from "../src/approval.js";
import { executeApprovedPurchase } from "../src/purchase-flow.js";
import { MockPurchaseExecutor } from "../src/mock-purchase-executor.js";
import { applyPurchaseToEntitlement } from "../src/entitlement.js";
import {
  createResumeRequest,
  createResumeResult,
} from "../src/resume.js";

describe("Full Aisle Recovery Flow", () => {
  it("recovers a task from insufficient credits to resume", async () => {
    const taskId = "e2e-full-001";

    const context = {
      taskId,
      originalPrompt:
        "Generate an image of a mountain.",
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

    const recoveryHandler = new RecoveryHandler({
      currentCredits: 180,
      taskRequiredCredits: 500,
      availablePlans: plans,
    });

    const wakeUpManager = new WakeUpManager(
      recoveryHandler,
    );

    const interceptor = new ErrorInterceptor(
      wakeUpManager,
    );

    await interceptor.handleError(
      {
        taskId,
        provider: "image-provider",
        toolName: "generate_image",
        toolArgs: {
          prompt:
            "Generate an image of a mountain.",
        },
        context,
      },
      {
        status: 402,
        code: "insufficient_credits",
        message: "Not enough credits.",
      },
    );

    const event = {
      taskId,
      provider: "image-provider",
      toolName: "generate_image",
      toolArgs: {
        prompt:
          "Generate an image of a mountain.",
      },
      errorType:
        "INSUFFICIENT_CREDITS" as const,
      rawError: {
        status: 402,
        code: "insufficient_credits",
        message: "Not enough credits.",
      },
      context,
      timestamp: new Date().toISOString(),
    };

    const recoveryDecision =
      recoveryHandler.createDecision(event);

    assert.equal(
      recoveryDecision.requiredCredits,
      320,
    );

    assert.equal(
      recoveryDecision.recommendation
        ?.recommended.id,
      "500",
    );

    const selection = selectPurchasePlan(
      recoveryDecision.recommendation!,
      "500",
    );

    assert.equal(
      selection.selectedPlan.id,
      "500",
    );

    assert.equal(
      selection.wasRecommended,
      true,
    );

    const approvalRequest =
      createApprovalRequest(
        taskId,
        "image-provider",
        selection.selectedPlan,
        recoveryDecision.requiredCredits,
      );

    assert.equal(
      approvalRequest.plan.id,
      "500",
    );

    const approvalDecision =
      recordApproval(
        approvalRequest,
        true,
      );

    assert.equal(
      approvalDecision.approved,
      true,
    );

    const purchaseExecutor =
      new MockPurchaseExecutor();

    const purchaseResult =
      await executeApprovedPurchase(
        approvalDecision,
        purchaseExecutor,
      );

    assert.equal(
      purchaseResult.status,
      "SUCCESS",
    );

    assert.equal(
      purchaseResult.plan.id,
      "500",
    );

    const entitlement =
      applyPurchaseToEntitlement(
        {
          credits: 180,
        },
        purchaseResult,
      );

    assert.equal(
      entitlement.credits,
      680,
    );

    const resumeRequest =
      createResumeRequest(
        event,
        purchaseResult,
        entitlement,
      );

    assert.equal(
      resumeRequest.taskId,
      taskId,
    );

    assert.equal(
      resumeRequest.originalPrompt,
      "Generate an image of a mountain.",
    );

    assert.equal(
      resumeRequest.entitlement.credits,
      680,
    );

    const resumeResult =
      createResumeResult(
        resumeRequest,
      );

    assert.equal(
      resumeResult.resumed,
      true,
    );

    assert.equal(
      resumeResult.taskId,
      taskId,
    );

    assert.match(
      resumeResult.message,
      /original task can resume/,
    );
  });
});