import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  selectPurchasePlan,
} from "../../src/recovery-flow/customer-selection.js";

import type {
  CreditPlan,
  PurchaseRecommendation,
} from "../../src/recovery-flow/purchase-recommender.js";

const recommendedPlan: CreditPlan = {
  id: "500",
  name: "500 Credits",
  credits: 500,
  price: 20,
  currency: "USD",
};

const alternativePlan1: CreditPlan = {
  id: "1000",
  name: "1000 Credits",
  credits: 1000,
  price: 35,
  currency: "USD",
};

const alternativePlan2: CreditPlan = {
  id: "2000",
  name: "2000 Credits",
  credits: 2000,
  price: 60,
  currency: "USD",
};

const recommendation: PurchaseRecommendation = {
  recommended: recommendedPlan,
  alternatives: [
    alternativePlan1,
    alternativePlan2,
  ],
};

describe("selectPurchasePlan", () => {
  it("selects the recommended plan", () => {
    const result = selectPurchasePlan(
      recommendation,
      "500",
    );

    assert.equal(result.selectedPlan.id, "500");
    assert.equal(result.wasRecommended, true);
  });

  it("allows the customer to choose an alternative plan", () => {
    const result = selectPurchasePlan(
      recommendation,
      "1000",
    );

    assert.equal(result.selectedPlan.id, "1000");
    assert.equal(result.wasRecommended, false);
  });

  it("allows the customer to choose another alternative plan", () => {
    const result = selectPurchasePlan(
      recommendation,
      "2000",
    );

    assert.equal(result.selectedPlan.id, "2000");
    assert.equal(result.wasRecommended, false);
  });

  it("rejects a plan that was not presented to the customer", () => {
    assert.throws(() =>
      selectPurchasePlan(
        recommendation,
        "9999",
      ),
    );
  });
});