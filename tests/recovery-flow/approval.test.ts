import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createApprovalRequest,
  recordApproval,
} from "../../src/recovery-flow/approval.js";

const plan = {
  id: "500",
  name: "500 Credits",
  credits: 500,
  price: 20,
  currency: "USD",
};

describe("createApprovalRequest", () => {
  it("creates an approval request with the purchase details", () => {
    const request = createApprovalRequest(
      "task-001",
      "image-provider",
      plan,
      320,
    );

    assert.equal(request.taskId, "task-001");
    assert.equal(request.provider, "image-provider");
    assert.equal(request.plan.id, "500");
    assert.equal(request.plan.credits, 500);
    assert.equal(request.plan.price, 20);
    assert.equal(
      request.reason,
      "The current task requires 320 additional credits.",
    );
  });
});

describe("recordApproval", () => {
  it("records an approved purchase", () => {
    const request = createApprovalRequest(
      "task-001",
      "image-provider",
      plan,
      320,
    );

    const decision = recordApproval(request, true);

    assert.equal(decision.approved, true);
    assert.equal(decision.request, request);
  });

  it("records a rejected purchase", () => {
    const request = createApprovalRequest(
      "task-001",
      "image-provider",
      plan,
      320,
    );

    const decision = recordApproval(request, false);

    assert.equal(decision.approved, false);
    assert.equal(decision.request, request);
  });
});