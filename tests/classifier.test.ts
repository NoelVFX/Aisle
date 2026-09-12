import assert from "node:assert/strict";
import test from "node:test";

import { classifyFailure } from "../src/classifier.js";
import {
  WakeUpManager,
  type WakeUpHandler,
} from "../src/wakeup-manager.js";
import type { FailureEvent } from "../src/event.js";

test("402 Payment Required should wake Aisle", () => {
  const result = classifyFailure({
    status: 402,
    error: "Payment Required",
  });

  assert.equal(result.classification, "PAYMENT_REQUIRED");
  assert.equal(result.recoverable, true);
});

test("insufficient_credits should wake Aisle", () => {
  const result = classifyFailure({
    status: 402,
    error: "insufficient_credits",
  });

  assert.equal(result.classification, "INSUFFICIENT_CREDITS");
  assert.equal(result.recoverable, true);
});

test("quota_exceeded should wake Aisle", () => {
  const result = classifyFailure({
    status: 429,
    error: "quota_exceeded",
  });

  assert.equal(result.classification, "QUOTA_EXCEEDED");
  assert.equal(result.recoverable, true);
});

test("plan_required should wake Aisle", () => {
  const result = classifyFailure({
    status: 402,
    error: "plan_required",
  });

  assert.equal(result.classification, "PLAN_REQUIRED");
  assert.equal(result.recoverable, true);
});

test("401 Unauthorized should NOT wake Aisle", () => {
  const result = classifyFailure({
    status: 401,
    error: "Unauthorized",
  });

  assert.equal(result.classification, "AUTH_REQUIRED");
  assert.equal(result.recoverable, false);
});

test("403 Forbidden should NOT wake Aisle", () => {
  const result = classifyFailure({
    status: 403,
    error: "Forbidden",
  });

  assert.equal(result.classification, "FORBIDDEN");
  assert.equal(result.recoverable, false);
});

test("404 Not Found should NOT wake Aisle", () => {
  const result = classifyFailure({
    status: 404,
    error: "Not Found",
  });

  assert.equal(result.classification, "NOT_FOUND");
  assert.equal(result.recoverable, false);
});

test("500 Server Error should NOT wake Aisle", () => {
  const result = classifyFailure({
    status: 500,
    error: "Internal Server Error",
  });

  assert.equal(result.classification, "SERVER_ERROR");
  assert.equal(result.recoverable, false);
});

test("Unknown error should NOT wake Aisle", () => {
  const result = classifyFailure({
    status: 418,
    error: "Something unexpected happened",
  });

  assert.equal(result.classification, "UNKNOWN");
  assert.equal(result.recoverable, false);
});

test("WakeUpManager should wake Aisle for a recoverable failure", async () => {
  let awakened = false;
  let receivedEvent: FailureEvent | undefined;

  const mockRecoveryAgent: WakeUpHandler = {
    async wake(event: FailureEvent): Promise<void> {
      awakened = true;
      receivedEvent = event;
    },
  };

  const manager = new WakeUpManager(mockRecoveryAgent);

  const event: FailureEvent = {
    taskId: "task-001",
    provider: "image-provider",
    toolName: "generate_image",
    toolArgs: {
      prompt: "three hero images",
    },
    errorType: "INSUFFICIENT_CREDITS",
    rawError: {
      status: 402,
      error: "insufficient_credits",
    },
    context: {
      taskId: "task-001",
      originalPrompt: "Generate three hero images.",
    },
    timestamp: new Date().toISOString(),
  };

  await manager.handle(event);

  assert.equal(awakened, true);
  assert.equal(receivedEvent?.taskId, "task-001");
  assert.equal(receivedEvent?.toolName, "generate_image");
  assert.equal(receivedEvent?.errorType, "INSUFFICIENT_CREDITS");
});

test("WakeUpManager should NOT wake Aisle for authentication failure", async () => {
  let awakened = false;

  const mockRecoveryAgent: WakeUpHandler = {
    async wake(): Promise<void> {
      awakened = true;
    },
  };

  const manager = new WakeUpManager(mockRecoveryAgent);

  const event: FailureEvent = {
    taskId: "task-002",
    provider: "image-provider",
    toolName: "generate_image",
    toolArgs: {
      prompt: "three hero images",
    },
    errorType: "AUTH_REQUIRED",
    rawError: {
      status: 401,
      error: "Unauthorized",
    },
    context: {
      taskId: "task-002",
    },
    timestamp: new Date().toISOString(),
  };

  await manager.handle(event);

  assert.equal(awakened, false);
});

test("WakeUpManager should not wake twice for the same failure", async () => {
  let wakeCount = 0;

  const mockRecoveryAgent: WakeUpHandler = {
    async wake(): Promise<void> {
      wakeCount += 1;
    },
  };

  const manager = new WakeUpManager(mockRecoveryAgent);

  const event: FailureEvent = {
    taskId: "task-dedup-001",
    provider: "image-provider",
    toolName: "generate_image",
    toolArgs: {
      prompt: "hero image",
    },
    errorType: "INSUFFICIENT_CREDITS",
    rawError: {
      status: 402,
      error: "insufficient_credits",
    },
    context: {
      taskId: "task-dedup-001",
      originalPrompt: "Generate a hero image.",
    },
    timestamp: new Date().toISOString(),
  };

  await manager.handle(event);
  await manager.handle(event);
  await manager.handle(event);

  assert.equal(wakeCount, 1);
});

test("WakeUpManager should allow different failures within the same task", async () => {
  let wakeCount = 0;

  const mockRecoveryAgent: WakeUpHandler = {
    async wake(): Promise<void> {
      wakeCount += 1;
    },
  };

  const manager = new WakeUpManager(mockRecoveryAgent);

  const insufficientCreditsEvent: FailureEvent = {
    taskId: "task-dedup-002",
    provider: "image-provider",
    toolName: "generate_image",
    toolArgs: {},
    errorType: "INSUFFICIENT_CREDITS",
    rawError: {},
    context: {
      taskId: "task-dedup-002",
    },
    timestamp: new Date().toISOString(),
  };

  const planRequiredEvent: FailureEvent = {
    taskId: "task-dedup-002",
    provider: "image-provider",
    toolName: "generate_image",
    toolArgs: {},
    errorType: "PLAN_REQUIRED",
    rawError: {},
    context: {
      taskId: "task-dedup-002",
    },
    timestamp: new Date().toISOString(),
  };

  await manager.handle(insufficientCreditsEvent);
  await manager.handle(planRequiredEvent);

  assert.equal(wakeCount, 2);
});

test("WakeUpManager should allow retry when the recovery handler fails", async () => {
  let wakeCount = 0;

  const mockRecoveryAgent: WakeUpHandler = {
    async wake(): Promise<void> {
      wakeCount += 1;

      if (wakeCount === 1) {
        throw new Error("Recovery agent temporarily unavailable");
      }
    },
  };

  const manager = new WakeUpManager(mockRecoveryAgent);

  const event: FailureEvent = {
    taskId: "task-retry-001",
    provider: "image-provider",
    toolName: "generate_image",
    toolArgs: {},
    errorType: "QUOTA_EXCEEDED",
    rawError: {
      status: 429,
      error: "quota_exceeded",
    },
    context: {
      taskId: "task-retry-001",
    },
    timestamp: new Date().toISOString(),
  };

  await assert.rejects(
    manager.handle(event),
    /Recovery agent temporarily unavailable/,
  );

  await manager.handle(event);

  assert.equal(wakeCount, 2);
});