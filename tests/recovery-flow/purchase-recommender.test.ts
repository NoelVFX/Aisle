import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  calculateRequiredCredits,
  recommendCreditPlan,
  type CreditPlan,
} from "../../src/recovery-flow/purchase-recommender.js";

const plans: CreditPlan[] = [
  {
    id: "100",
    name: "100 Credits",
    credits: 100,
    price: 5,
    currency: "USD",
  },
  {
    id: "500",
    name: "500 Credits",
    credits: 500,
    price: 20,
    currency: "USD",
  },
  {
    id: "1000",
    name: "1000 Credits",
    credits: 1000,
    price: 35,
    currency: "USD",
  },
];

describe("calculateRequiredCredits", () => {
  it("calculates the additional credits required", () => {
    const result = calculateRequiredCredits(500, 180);

    assert.equal(result, 320);
  });

  it("returns zero when the user already has enough credits", () => {
    const result = calculateRequiredCredits(500, 600);

    assert.equal(result, 0);
  });

  it("returns zero when task requires exactly the current balance", () => {
    const result = calculateRequiredCredits(500, 500);

    assert.equal(result, 0);
  });

  it("throws when taskRequiredCredits is negative", () => {
    assert.throws(() =>
      calculateRequiredCredits(-100, 50),
    );
  });

  it("throws when currentCredits is negative", () => {
    assert.throws(() =>
      calculateRequiredCredits(100, -50),
    );
  });
});

describe("recommendCreditPlan", () => {
  it("recommends the smallest sufficient package", () => {
    const result = recommendCreditPlan({
      requiredCredits: 320,
      plans,
    });

    assert.equal(result.recommended.id, "500");
  });

  it("returns larger sufficient packages as alternatives", () => {
    const result = recommendCreditPlan({
      requiredCredits: 320,
      plans,
    });

    assert.deepEqual(
      result.alternatives.map((plan) => plan.id),
      ["1000"],
    );
  });

  it("does not include insufficient packages as alternatives", () => {
    const result = recommendCreditPlan({
      requiredCredits: 80,
      plans,
    });

    assert.equal(result.recommended.id, "100");

    assert.deepEqual(
      result.alternatives.map((plan) => plan.id),
      ["500", "1000"],
    );
  });

  it("throws when no package can satisfy the requirement", () => {
    assert.throws(() =>
      recommendCreditPlan({
        requiredCredits: 5000,
        plans,
      }),
    );
  });

  it("throws when there are no plans", () => {
    assert.throws(() =>
      recommendCreditPlan({
        requiredCredits: 100,
        plans: [],
      }),
    );
  });

  it("throws when required credits are invalid", () => {
    assert.throws(() =>
      recommendCreditPlan({
        requiredCredits: 0,
        plans,
      }),
    );
  });
});