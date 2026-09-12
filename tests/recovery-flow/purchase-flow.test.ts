import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createApprovalRequest,
  recordApproval,
} from "../../src/recovery-flow/approval.js";

import {
  executeApprovedPurchase,
} from "../../src/recovery-flow/purchase-flow.js";

import type {
  PurchaseExecutor,
  PurchaseRequest,
  PurchaseResult,
} from "../../src/recovery-flow/purchase-executor.js";

const plan = {
  id: "500",
  name: "500 Credits",
  credits: 500,
  price: 20,
  currency: "USD",
};

class TestPurchaseExecutor
  implements PurchaseExecutor
{
  public callCount = 0;

  async purchase(
    request: PurchaseRequest,
  ): Promise<PurchaseResult> {
    this.callCount += 1;

    return {
      status: "SUCCESS",
      plan: request.plan,
      transactionId: "tx-test-001",
      message: "Purchase successful.",
    };
  }
}

describe("executeApprovedPurchase", () => {
  it("executes a purchase when the customer approves", async () => {
    const request = createApprovalRequest(
      "task-001",
      "image-provider",
      plan,
      320,
    );

    const decision = recordApproval(
      request,
      true,
    );

    const executor = new TestPurchaseExecutor();

    const result = await executeApprovedPurchase(
      decision,
      executor,
    );

    assert.equal(result.status, "SUCCESS");
    assert.equal(result.plan.id, "500");
    assert.equal(
      result.transactionId,
      "tx-test-001",
    );
    assert.equal(
      executor.callCount,
      1,
    );
  });

  it("does not execute a purchase when the customer rejects", async () => {
    const request = createApprovalRequest(
      "task-001",
      "image-provider",
      plan,
      320,
    );

    const decision = recordApproval(
      request,
      false,
    );

    const executor = new TestPurchaseExecutor();

    await assert.rejects(
      executeApprovedPurchase(
        decision,
        executor,
      ),
      /without customer approval/,
    );

    assert.equal(
      executor.callCount,
      0,
    );
  });
});