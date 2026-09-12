import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyPurchaseToEntitlement } from "../src/entitlement.js";

describe("applyPurchaseToEntitlement", () => {
  it("adds purchased credits to the current balance", () => {
    const result = applyPurchaseToEntitlement(
      {
        credits: 180,
      },
      {
        status: "SUCCESS",
        plan: {
          id: "500",
          name: "500 Credits",
          credits: 500,
          price: 20,
          currency: "USD",
        },
        transactionId: "tx-001",
        message: "Purchase successful.",
      },
    );

    assert.equal(result.credits, 680);
  });

  it("does not modify the original entitlement state", () => {
    const state = {
      credits: 180,
    };

    applyPurchaseToEntitlement(state, {
      status: "SUCCESS",
      plan: {
        id: "500",
        name: "500 Credits",
        credits: 500,
        price: 20,
        currency: "USD",
      },
      transactionId: "tx-001",
      message: "Purchase successful.",
    });

    assert.equal(state.credits, 180);
  });

  it("rejects an unsuccessful purchase", () => {
    assert.throws(() =>
      applyPurchaseToEntitlement(
        {
          credits: 180,
        },
        {
          status: "FAILED",
          plan: {
            id: "500",
            name: "500 Credits",
            credits: 500,
            price: 20,
            currency: "USD",
          },
          message: "Purchase failed.",
        },
      ),
    );
  });

  it("rejects an unknown purchase result", () => {
    assert.throws(() =>
      applyPurchaseToEntitlement(
        {
          credits: 180,
        },
        {
          status: "UNKNOWN",
          plan: {
            id: "500",
            name: "500 Credits",
            credits: 500,
            price: 20,
            currency: "USD",
          },
          message: "Purchase result is unknown.",
        },
      ),
    );
  });
});