export interface CreditPlan {
  id: string;
  name: string;
  credits: number;
  price: number;
  currency: string;
}

export interface PurchaseRecommendationInput {
  requiredCredits: number;
  plans: CreditPlan[];
}

export interface PurchaseRecommendation {
  recommended: CreditPlan;
  alternatives: CreditPlan[];
}

/**
 * Calculate how many additional credits are required
 * to complete the current task.
 *
 * Example:
 * task requires 500 credits
 * user currently has 180 credits
 * result = 320
 */
export function calculateRequiredCredits(
  taskRequiredCredits: number,
  currentCredits: number,
): number {
  if (taskRequiredCredits < 0) {
    throw new Error("taskRequiredCredits cannot be negative.");
  }

  if (currentCredits < 0) {
    throw new Error("currentCredits cannot be negative.");
  }

  return Math.max(taskRequiredCredits - currentCredits, 0);
}

/**
 * Recommend the smallest credit package that can satisfy
 * the current task's credit requirement.
 *
 * The recommendation does not authorize or perform a purchase.
 */
export function recommendCreditPlan(
  input: PurchaseRecommendationInput,
): PurchaseRecommendation {
  if (input.requiredCredits <= 0) {
    throw new Error("requiredCredits must be greater than 0.");
  }

  if (input.plans.length === 0) {
    throw new Error("No credit plans are available.");
  }

  const eligiblePlans = input.plans
    .filter((plan) => plan.credits >= input.requiredCredits)
    .sort((a, b) => {
      if (a.credits !== b.credits) {
        return a.credits - b.credits;
      }

      return a.price - b.price;
    });

  if (eligiblePlans.length === 0) {
    throw new Error(
      `No credit plan can satisfy ${input.requiredCredits} required credits.`,
    );
  }

  const [recommended, ...alternatives] = eligiblePlans;

  if (!recommended) {
    throw new Error(
      `No credit plan can satisfy ${input.requiredCredits} required credits.`,
    );
  }

  return {
    recommended,
    alternatives,
  };
}