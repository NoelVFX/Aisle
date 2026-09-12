import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ErrorInterceptor,
  type ToolCallInfo,
} from "../src/interceptor.js";

import {
  WakeUpManager,
  type WakeUpHandler,
} from "../src/wakeup-manager.js";

import type { FailureEvent } from "../src/event.js";

test("End-to-End: payment failure should wake Aisle and preserve task context", async () => {
  let wakeCount = 0;
  let recoveryEvent: FailureEvent | undefined;

  const recoveryAgent: WakeUpHandler = {
    async wake(event: FailureEvent): Promise<void> {
      wakeCount += 1;
      recoveryEvent = event;
    },
  };

  const wakeUpManager = new WakeUpManager(recoveryAgent);
  const interceptor = new ErrorInterceptor(wakeUpManager);

  const toolCall: ToolCallInfo = {
    taskId: "task-e2e-001",
    provider: "image-provider",
    toolName: "generate_image",
    toolArgs: {
      prompt: "Generate three hero images",
      size: "1024x1024",
    },
    context: {
      taskId: "task-e2e-001",
      originalPrompt: "Generate three hero images for the landing page.",
      metadata: {
        retryCount: 0,
      },
    },
  };

  const rawToolError = {
    statusCode: 402,
    code: "insufficient_credits",
    message: "You do not have enough credits.",
  };

  const event = await interceptor.handleError(
    toolCall,
    rawToolError,
  );

  assert.equal(event.taskId, "task-e2e-001");
  assert.equal(event.provider, "image-provider");
  assert.equal(event.toolName, "generate_image");

  assert.equal(
    event.errorType,
    "INSUFFICIENT_CREDITS",
  );

  assert.deepEqual(event.rawError, rawToolError);

  assert.equal(
    event.context.originalPrompt,
    "Generate three hero images for the landing page.",
  );

  assert.equal(wakeCount, 1);
  assert.equal(recoveryEvent?.taskId, "task-e2e-001");
  assert.equal(
    recoveryEvent?.errorType,
    "INSUFFICIENT_CREDITS",
  );
});

test("End-to-End: authentication failure should not wake Aisle", async () => {
  let wakeCount = 0;

  const recoveryAgent: WakeUpHandler = {
    async wake(): Promise<void> {
      wakeCount += 1;
    },
  };

  const wakeUpManager = new WakeUpManager(recoveryAgent);
  const interceptor = new ErrorInterceptor(wakeUpManager);

  const toolCall: ToolCallInfo = {
    taskId: "task-e2e-002",
    provider: "image-provider",
    toolName: "generate_image",
    toolArgs: {
      prompt: "Test image",
    },
    context: {
      taskId: "task-e2e-002",
      originalPrompt: "Generate a test image.",
    },
  };

  await interceptor.handleError(
    toolCall,
    {
      status: 401,
      code: "unauthorized",
      message: "Authentication required.",
    },
  );

  assert.equal(wakeCount, 0);
});

test("End-to-End: repeated payment failure should only wake once", async () => {
  let wakeCount = 0;

  const recoveryAgent: WakeUpHandler = {
    async wake(): Promise<void> {
      wakeCount += 1;
    },
  };

  const wakeUpManager = new WakeUpManager(recoveryAgent);
  const interceptor = new ErrorInterceptor(wakeUpManager);

  const toolCall: ToolCallInfo = {
    taskId: "task-e2e-003",
    provider: "image-provider",
    toolName: "generate_image",
    toolArgs: {
      prompt: "Generate a hero image",
    },
    context: {
      taskId: "task-e2e-003",
      originalPrompt: "Generate a hero image.",
    },
  };

  const rawToolError = {
    status: 402,
    error: "insufficient_credits",
  };

  await interceptor.handleError(toolCall, rawToolError);
  await interceptor.handleError(toolCall, rawToolError);
  await interceptor.handleError(toolCall, rawToolError);

  assert.equal(wakeCount, 1);
});