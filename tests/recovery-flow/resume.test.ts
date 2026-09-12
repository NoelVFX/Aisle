import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createResumeRequest,
  createResumeResult,
} from "../../src/recovery-flow/resume.js";

import type { FailureEvent } from "../../src/event.js";

const failureEvent: FailureEvent = {
  taskId: "task-resume-001",
  provider: "image-provider",
  toolName: "generate_image",
  toolArgs: {},
  errorType: "INSUFFICIENT_CREDITS",
  rawError: {
    status: 402,
    code: "insufficient_credits",
  },
  context: {
    taskId: "task-resume-001",
    originalPrompt: "Generate an image",
  },
  timestamp: new Date().toISOString(),
};

const purchaseResult = {
  status: "SUCCESS" as const,
  plan: {
    id: "500",
    name: "500 Credits",
    credits: 500,
    price: 20,
    currency: "USD",
  },
  transactionId: "tx-resume-001",
  message: "Purchase successful.",
};

describe("createResumeRequest", () => {
  it("creates a resume request with task context", () => {
    const request = createResumeRequest(
      failureEvent,
      purchaseResult,
      {
        credits: 680,
      },
    );

    assert.equal(
      request.taskId,
      "task-resume-001",
    );

    assert.equal(
      request.originalPrompt,
      "Generate an image",
    );

    assert.equal(
      request.purchase.transactionId,
      "tx-resume-001",
    );

    assert.equal(
      request.entitlement.credits,
      680,
    );
  });
});

describe("createResumeResult", () => {
  it("marks the task as ready to resume", () => {
    const request = createResumeRequest(
      failureEvent,
      purchaseResult,
      {
        credits: 680,
      },
    );

    const result = createResumeResult(
      request,
    );

    assert.equal(
      result.resumed,
      true,
    );

    assert.equal(
      result.taskId,
      "task-resume-001",
    );

    assert.match(
      result.message,
      /original task can resume/,
    );
  });
});