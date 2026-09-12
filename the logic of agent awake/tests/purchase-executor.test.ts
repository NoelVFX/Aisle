import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MockPurchaseExecutor,
} from "../src/mock-purchase-executor.js";

const plan = {
  id: "500",
  name: "500 Credits",
  credits: 500,
  price: 20,
  currency: "USD",
};

describe("MockPurchaseExecutor", () => {
  it("successfully purchases the selected plan", async () => {
    const executor = new MockPurchaseExecutor();

    const result = await executor.purchase({
      taskId: "task-001",
      provider: "image-provider",
      plan,
    });

    assert.equal(result.status, "SUCCESS");
    assert.equal(result.plan.id, "500");
    assert.equal(
      result.plan.credits,
      500,
    );
    assert.equal(
      result.transactionId,
      "mock-tx-task-001",
    );
  });

  it("returns a success message", async () => {
    const executor = new MockPurchaseExecutor();

    const result = await executor.purchase({
      taskId: "task-001",
      provider: "image-provider",
      plan,
    });

    assert.equal(
      result.message,
      "Successfully purchased 500 credits.",
    );
  });
});