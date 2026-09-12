import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createRecoverySession,
  transitionRecoverySession,
} from "../../src/recovery-flow/recovery-session.js";

describe("RecoverySession", () => {
  it("starts in RECOVERY_REQUIRED", () => {
    const session = createRecoverySession("task-001");

    assert.equal(session.taskId, "task-001");
    assert.equal(
      session.status,
      "RECOVERY_REQUIRED",
    );
  });

  it("allows the normal recovery flow", () => {
    let session = createRecoverySession("task-002");

    session = transitionRecoverySession(
      session,
      "PLAN_RECOMMENDED",
    );

    session = transitionRecoverySession(
      session,
      "CUSTOMER_SELECTED",
    );

    session = transitionRecoverySession(
      session,
      "AWAITING_APPROVAL",
    );

    session = transitionRecoverySession(
      session,
      "APPROVED",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASING",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASED",
    );

    session = transitionRecoverySession(
      session,
      "ENTITLEMENT_UPDATED",
    );

    session = transitionRecoverySession(
      session,
      "READY_TO_RESUME",
    );

    assert.equal(
      session.status,
      "READY_TO_RESUME",
    );
  });

  it("does not allow skipping customer selection", () => {
    const session = createRecoverySession("task-003");

    const recommended = transitionRecoverySession(
      session,
      "PLAN_RECOMMENDED",
    );

    assert.throws(() =>
      transitionRecoverySession(
        recommended,
        "AWAITING_APPROVAL",
      ),
    );
  });

  it("does not allow purchasing before approval", () => {
    let session = createRecoverySession("task-004");

    session = transitionRecoverySession(
      session,
      "PLAN_RECOMMENDED",
    );

    session = transitionRecoverySession(
      session,
      "CUSTOMER_SELECTED",
    );

    session = transitionRecoverySession(
      session,
      "AWAITING_APPROVAL",
    );

    assert.throws(() =>
      transitionRecoverySession(
        session,
        "PURCHASING",
      ),
    );
  });

  it("does not allow skipping entitlement update", () => {
    let session = createRecoverySession("task-005");

    session = transitionRecoverySession(
      session,
      "PLAN_RECOMMENDED",
    );

    session = transitionRecoverySession(
      session,
      "CUSTOMER_SELECTED",
    );

    session = transitionRecoverySession(
      session,
      "AWAITING_APPROVAL",
    );

    session = transitionRecoverySession(
      session,
      "APPROVED",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASING",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASED",
    );

    assert.throws(() =>
      transitionRecoverySession(
        session,
        "READY_TO_RESUME",
      ),
    );
  });

  it("does not allow transitions after READY_TO_RESUME", () => {
    let session = createRecoverySession("task-006");

    session = transitionRecoverySession(
      session,
      "PLAN_RECOMMENDED",
    );

    session = transitionRecoverySession(
      session,
      "CUSTOMER_SELECTED",
    );

    session = transitionRecoverySession(
      session,
      "AWAITING_APPROVAL",
    );

    session = transitionRecoverySession(
      session,
      "APPROVED",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASING",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASED",
    );

    session = transitionRecoverySession(
      session,
      "ENTITLEMENT_UPDATED",
    );

    session = transitionRecoverySession(
      session,
      "READY_TO_RESUME",
    );

    assert.throws(() =>
      transitionRecoverySession(
        session,
        "PURCHASING",
      ),
    );
  });

  it("allows a purchase to transition to PURCHASE_FAILED", () => {
    let session = createRecoverySession("task-007");

    session = transitionRecoverySession(
      session,
      "PLAN_RECOMMENDED",
    );

    session = transitionRecoverySession(
      session,
      "CUSTOMER_SELECTED",
    );

    session = transitionRecoverySession(
      session,
      "AWAITING_APPROVAL",
    );

    session = transitionRecoverySession(
      session,
      "APPROVED",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASING",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASE_FAILED",
    );

    assert.equal(
      session.status,
      "PURCHASE_FAILED",
    );
  });

  it("does not allow a failed purchase to update entitlement", () => {
    let session = createRecoverySession("task-008");

    session = transitionRecoverySession(
      session,
      "PLAN_RECOMMENDED",
    );

    session = transitionRecoverySession(
      session,
      "CUSTOMER_SELECTED",
    );

    session = transitionRecoverySession(
      session,
      "AWAITING_APPROVAL",
    );

    session = transitionRecoverySession(
      session,
      "APPROVED",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASING",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASE_FAILED",
    );

    assert.throws(() =>
      transitionRecoverySession(
        session,
        "ENTITLEMENT_UPDATED",
      ),
    );
  });

  it("does not allow a failed purchase to resume the task", () => {
    let session = createRecoverySession("task-009");

    session = transitionRecoverySession(
      session,
      "PLAN_RECOMMENDED",
    );

    session = transitionRecoverySession(
      session,
      "CUSTOMER_SELECTED",
    );

    session = transitionRecoverySession(
      session,
      "AWAITING_APPROVAL",
    );

    session = transitionRecoverySession(
      session,
      "APPROVED",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASING",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASE_FAILED",
    );

    assert.throws(() =>
      transitionRecoverySession(
        session,
        "READY_TO_RESUME",
      ),
    );
  });

  it("allows a purchase to transition to PURCHASE_UNKNOWN", () => {
    let session = createRecoverySession("task-010");

    session = transitionRecoverySession(
      session,
      "PLAN_RECOMMENDED",
    );

    session = transitionRecoverySession(
      session,
      "CUSTOMER_SELECTED",
    );

    session = transitionRecoverySession(
      session,
      "AWAITING_APPROVAL",
    );

    session = transitionRecoverySession(
      session,
      "APPROVED",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASING",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASE_UNKNOWN",
    );

    assert.equal(
      session.status,
      "PURCHASE_UNKNOWN",
    );
  });

  it("does not allow an unknown purchase result to update entitlement", () => {
    let session = createRecoverySession("task-011");

    session = transitionRecoverySession(
      session,
      "PLAN_RECOMMENDED",
    );

    session = transitionRecoverySession(
      session,
      "CUSTOMER_SELECTED",
    );

    session = transitionRecoverySession(
      session,
      "AWAITING_APPROVAL",
    );

    session = transitionRecoverySession(
      session,
      "APPROVED",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASING",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASE_UNKNOWN",
    );

    assert.throws(() =>
      transitionRecoverySession(
        session,
        "ENTITLEMENT_UPDATED",
      ),
    );
  });

  it("does not allow an unknown purchase result to resume the task", () => {
    let session = createRecoverySession("task-012");

    session = transitionRecoverySession(
      session,
      "PLAN_RECOMMENDED",
    );

    session = transitionRecoverySession(
      session,
      "CUSTOMER_SELECTED",
    );

    session = transitionRecoverySession(
      session,
      "AWAITING_APPROVAL",
    );

    session = transitionRecoverySession(
      session,
      "APPROVED",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASING",
    );

    session = transitionRecoverySession(
      session,
      "PURCHASE_UNKNOWN",
    );

    assert.throws(() =>
      transitionRecoverySession(
        session,
        "READY_TO_RESUME",
      ),
    );
  });
});