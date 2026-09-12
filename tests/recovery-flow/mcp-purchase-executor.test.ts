import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  McpPurchaseExecutor,
  type McpPurchaseFunction,
} from "../../src/recovery-flow/mcp-purchase-executor.js";

const plan = {
  id: "500",
  name: "500 Credits",
  credits: 500,
  price: 20,
  currency: "USD",
};

describe("McpPurchaseExecutor", () => {
  it("forwards the purchase request to the MCP purchase function", async () => {
    let receivedRequest: unknown;

    const purchaseCredits: McpPurchaseFunction = async (
      request,
    ) => {
      receivedRequest = request;

      return {
        status: "SUCCESS",
        transactionId: "mcp-tx-001",
        message: "MCP purchase successful.",
      };
    };

    const executor = new McpPurchaseExecutor(
      purchaseCredits,
    );

    const result = await executor.purchase({
      taskId: "task-mcp-001",
      provider: "image-provider",
      plan,
    });

    assert.deepEqual(receivedRequest, {
      taskId: "task-mcp-001",
      provider: "image-provider",
      plan,
    });

    assert.equal(result.status, "SUCCESS");
    assert.equal(
      result.transactionId,
      "mcp-tx-001",
    );
    assert.equal(result.plan.id, "500");
    assert.equal(
      result.message,
      "MCP purchase successful.",
    );
  });

  it("preserves a failed MCP purchase result", async () => {
    const purchaseCredits: McpPurchaseFunction = async () => {
      return {
        status: "FAILED",
        message: "MCP purchase failed.",
      };
    };

    const executor = new McpPurchaseExecutor(
      purchaseCredits,
    );

    const result = await executor.purchase({
      taskId: "task-mcp-002",
      provider: "image-provider",
      plan,
    });

    assert.equal(result.status, "FAILED");
    assert.equal(
      result.transactionId,
      undefined,
    );
    assert.equal(
      result.message,
      "MCP purchase failed.",
    );
    assert.equal(result.plan.id, "500");
  });

  it("preserves an unknown MCP purchase result", async () => {
    const purchaseCredits: McpPurchaseFunction = async () => {
      return {
        status: "UNKNOWN",
        message: "MCP purchase result is unknown.",
      };
    };

    const executor = new McpPurchaseExecutor(
      purchaseCredits,
    );

    const result = await executor.purchase({
      taskId: "task-mcp-003",
      provider: "image-provider",
      plan,
    });

    assert.equal(result.status, "UNKNOWN");
    assert.equal(
      result.message,
      "MCP purchase result is unknown.",
    );
    assert.equal(result.plan.id, "500");
  });

  it("uses a default success message when MCP does not provide one", async () => {
    const purchaseCredits: McpPurchaseFunction = async () => {
      return {
        status: "SUCCESS",
        transactionId: "mcp-tx-004",
      };
    };

    const executor = new McpPurchaseExecutor(
      purchaseCredits,
    );

    const result = await executor.purchase({
      taskId: "task-mcp-004",
      provider: "image-provider",
      plan,
    });

    assert.equal(result.status, "SUCCESS");
    assert.equal(
      result.message,
      "Successfully purchased 500 credits.",
    );
  });
});