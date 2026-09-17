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

test("Interceptor should turn a payment error into a FailureEvent and wake Aisle", async () => {
  let awakened = false;
  let receivedEvent: FailureEvent | undefined;

  const mockRecoveryAgent: WakeUpHandler = {
    async wake(event: FailureEvent): Promise<void> {
      awakened = true;
      receivedEvent = event;
    },
  };

  const wakeUpManager = new WakeUpManager(mockRecoveryAgent);
  const interceptor = new ErrorInterceptor(wakeUpManager);

  const toolCall: ToolCallInfo = {
    taskId: "task-100",
    provider: "image-provider",
    toolName: "generate_image",
    toolArgs: {
      prompt: "three hero images",
    },
    context: {
      taskId: "task-100",
      originalPrompt: "Generate three hero images.",
    },
  };

  const rawError = {
    status: 402,
    error: "insufficient_credits",
  };

  const event = await interceptor.handleError(toolCall, rawError);

  assert.equal(event.taskId, "task-100");
  assert.equal(event.provider, "image-provider");
  assert.equal(event.toolName, "generate_image");
  assert.equal(event.errorType, "INSUFFICIENT_CREDITS");
  assert.deepEqual(event.rawError, rawError);

  assert.equal(awakened, true);
  assert.equal(receivedEvent?.taskId, "task-100");
});

test("Interceptor should create an event but NOT wake Aisle for authentication errors", async () => {
  let awakened = false;

  const mockRecoveryAgent: WakeUpHandler = {
    async wake(): Promise<void> {
      awakened = true;
    },
  };

  const wakeUpManager = new WakeUpManager(mockRecoveryAgent);
  const interceptor = new ErrorInterceptor(wakeUpManager);

  const toolCall: ToolCallInfo = {
    taskId: "task-101",
    provider: "image-provider",
    toolName: "generate_image",
    toolArgs: {
      prompt: "test image",
    },
    context: {
      taskId: "task-101",
    },
  };

  const event = await interceptor.handleError(toolCall, {
    status: 401,
    error: "Unauthorized",
  });

  assert.equal(event.taskId, "task-101");
  assert.equal(event.errorType, "AUTH_REQUIRED");
  assert.equal(awakened, false);
});

test("Interceptor should preserve the original agent context", async () => {
  let receivedEvent: FailureEvent | undefined;

  const mockRecoveryAgent: WakeUpHandler = {
    async wake(event: FailureEvent): Promise<void> {
      receivedEvent = event;
    },
  };

  const wakeUpManager = new WakeUpManager(mockRecoveryAgent);
  const interceptor = new ErrorInterceptor(wakeUpManager);

  const context = {
    taskId: "task-102",
    originalPrompt: "Generate three hero images and return the URLs.",
    metadata: {
      userId: "demo-user",
      retryCount: 0,
    },
  };

  await interceptor.handleError(
    {
      taskId: "task-102",
      provider: "image-provider",
      toolName: "generate_image",
      toolArgs: {
        prompt: "hero image",
        size: "1024x1024",
      },
      context,
    },
    {
      status: 402,
      error: "quota_exceeded",
    },
  );

  assert.deepEqual(receivedEvent?.context, context);
  assert.equal(receivedEvent?.toolName, "generate_image");
  assert.deepEqual(receivedEvent?.toolArgs, {
    prompt: "hero image",
    size: "1024x1024",
  });
});