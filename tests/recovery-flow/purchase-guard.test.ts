import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  PurchaseGuard,
} from "../../src/recovery-flow/purchase-guard.js";

describe("PurchaseGuard", () => {
  it("allows the first purchase", () => {
    const guard = new PurchaseGuard();

    const key = {
      taskId: "task-001",
      provider: "image-provider",
      planId: "500",
    };

    assert.equal(
      guard.canPurchase(key),
      true,
    );

    assert.equal(
      guard.acquire(key),
      true,
    );
  });

  it("blocks the same purchase from being executed twice", () => {
    const guard = new PurchaseGuard();

    const key = {
      taskId: "task-002",
      provider: "image-provider",
      planId: "500",
    };

    assert.equal(
      guard.acquire(key),
      true,
    );

    assert.equal(
      guard.acquire(key),
      false,
    );

    assert.equal(
      guard.canPurchase(key),
      false,
    );
  });

  it("allows a different plan for the same task", () => {
    const guard = new PurchaseGuard();

    const firstPlan = {
      taskId: "task-003",
      provider: "image-provider",
      planId: "500",
    };

    const secondPlan = {
      taskId: "task-003",
      provider: "image-provider",
      planId: "1000",
    };

    assert.equal(
      guard.acquire(firstPlan),
      true,
    );

    assert.equal(
      guard.acquire(secondPlan),
      true,
    );
  });

  it("allows the same plan for a different task", () => {
    const guard = new PurchaseGuard();

    const firstTask = {
      taskId: "task-004",
      provider: "image-provider",
      planId: "500",
    };

    const secondTask = {
      taskId: "task-005",
      provider: "image-provider",
      planId: "500",
    };

    assert.equal(
      guard.acquire(firstTask),
      true,
    );

    assert.equal(
      guard.acquire(secondTask),
      true,
    );
  });

  it("allows the same plan for a different provider", () => {
    const guard = new PurchaseGuard();

    const firstProvider = {
      taskId: "task-006",
      provider: "image-provider",
      planId: "500",
    };

    const secondProvider = {
      taskId: "task-006",
      provider: "video-provider",
      planId: "500",
    };

    assert.equal(
      guard.acquire(firstProvider),
      true,
    );

    assert.equal(
      guard.acquire(secondProvider),
      true,
    );
  });

  it("markPurchased blocks a future purchase", () => {
    const guard = new PurchaseGuard();

    const key = {
      taskId: "task-007",
      provider: "image-provider",
      planId: "500",
    };

    assert.equal(
      guard.canPurchase(key),
      true,
    );

    guard.markPurchased(key);

    assert.equal(
      guard.canPurchase(key),
      false,
    );

    assert.equal(
      guard.acquire(key),
      false,
    );
  });
});