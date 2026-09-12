# Aisle Agent Wake-up Logic

This module implements the event-driven wake-up layer for Aisle.

Aisle is a recovery agent that activates when an original AI agent encounters

a recoverable payment-related failure while executing a task.

The wake-up module does not perform purchases itself. Its responsibility is to:

1. Detect recoverable payment-related failures.

2. Normalize errors from different providers.

3. Classify the failure.

4. Preserve the original task context.

5. Create a `FailureEvent`.

6. Trigger a recovery agent.

7. Prevent duplicate wake-ups for the same failure.

8. Allow retry if the recovery handler itself fails.

---

## Architecture

```text

                    Original Agent

                          |

                          v

                    MCP Tool Call

                          |

                          v

                  Tool / Provider Error

                          |

                          v

               +-----------------------+
               |   Error Interceptor   |
               +-----------+-----------+
                           |
                           v
               +-----------------------+
               |    Error Normalizer   |
               +-----------+-----------+
                           |
                           v
               +-----------------------+
               |   Failure Classifier  |
               +-----------+-----------+
                           |
                           v
                    FailureEvent
                           |
                           v
               +-----------------------+
               |    WakeUpManager      |
               +-----------+-----------+
                           |
                    Recoverable?
                     /           \
                   YES            NO
                    |              |
                    v              v
              WakeUpHandler      Ignore
                    |
                    v
              Recovery Agent
                    |
                    v
          Purchase / Browser / Resume
```

---

## Module Responsibilities

### `src/error-normalizer.ts`

Converts different provider error formats into one predictable representation.

Supported examples include:

```json
{ "status": 402, "error": "insufficient_credits" }
```

```json
{ "statusCode": 429, "code": "quota_exceeded" }
```

```text
Error("HTTP 402 Payment Required")
```

```text
"HTTP 402 Payment Required"
```

Output:

```typescript
interface NormalizedError {
  status?: number;
  code?: string;
  message?: string;
  raw: unknown;
}
```

---

### `src/classifier.ts`

Determines whether an error is recoverable through a payment-related recovery flow.

Recoverable failures currently include:

```text
PAYMENT_REQUIRED

QUOTA_EXCEEDED

INSUFFICIENT_CREDITS

PLAN_REQUIRED
```

Failures that do not trigger a purchase recovery include:

```text
AUTH_REQUIRED

FORBIDDEN

NOT_FOUND

SERVER_ERROR

UNKNOWN
```

The classifier prioritizes:

```text
Explicit error code
        |
        v
HTTP status
        |
        v
Error message
        |
        v
UNKNOWN
```

---

### `src/event.ts`

Defines the event passed to the recovery layer.

```typescript
interface FailureEvent {
  taskId: string;
  provider: string;
  toolName: string;
  toolArgs: unknown;
  errorType: FailureClassification;
  rawError: unknown;
  context: AgentContext;
  timestamp: string;
}
```

The original agent context is preserved so that recovery can resume the

existing task instead of restarting it from scratch.

---

### `src/interceptor.ts`

Connects the raw provider error to the wake-up system.

Flow:

```text
Raw Tool Error
      |
      v
normalize + classify
      |
      v
FailureEvent
      |
      v
WakeUpManager
```

The interceptor does not purchase anything.

---

### `src/wakeup-manager.ts`

Controls whether Aisle should wake up.

It provides:

```typescript
interface WakeUpHandler {
  wake(event: FailureEvent): Promise<void>;
}
```

The WakeUpManager also provides a loop guard.

For the same:

```text
taskId
+
provider
+
toolName
+
errorType
```

only one successful wake-up is triggered.

If the recovery handler itself fails, the wake key is removed so another attempt

can be made.

---

## Example

A provider returns:

```json
{
  "statusCode": 402,
  "code": "insufficient_credits",
  "message": "You do not have enough credits."
}
```

The system converts this into:

```text
INSUFFICIENT_CREDITS

recoverable = true
```

Then:

```text
FailureEvent
     |
     v
WakeUpManager
     |
     v
WakeUpHandler
     |
     v
Recovery Agent
```

A different error such as:

```json
{
  "status": 401,
  "code": "unauthorized"
}
```

is classified as:

```text
AUTH_REQUIRED

recoverable = false
```

and does not trigger the recovery agent.

---

# Recovery and Purchase Flow

The wake-up layer has been extended with a recovery and purchase-decision
pipeline while keeping the wake-up logic independent from the actual payment
implementation.

The current flow is:

```text
Recoverable Payment Failure
          |
          v
      Aisle Wake-up
          |
          v
   Recovery Decision
          |
          v
 Calculate Required Credits
          |
          v
 Purchase Recommendation
          |
          +----------------------+
          |                      |
          v                      v
 Recommended Plan        Other Eligible Plans
          |                      |
          +----------+-----------+
                     |
                     v
             Customer Selection
                     |
                     v
             Approval Boundary
                     |
              +------+------+
              |             |
            Reject        Approve
              |             |
              v             v
             Stop     Purchase Executor
                            |
                 +----------+----------+
                 |          |          |
                 v          v          v
              SUCCESS     FAILED    UNKNOWN
                 |          |          |
                 v          v          v
          Entitlement      Stop       Stop Safely
             Update
                 |
                 v
         Resume Original Task
```

---

## `src/recovery.ts`

Calculates the additional credits required by the task and creates a purchase
recommendation.

Example:

```text
Task requires: 500 credits
Current balance: 180 credits

Additional credits required:
320
```

The recovery decision does not perform a purchase.

---

## `src/purchase-recommender.ts`

Recommends the smallest credit package that satisfies the remaining
requirement.

Example:

```text
Required: 320 credits

Available:
100 credits
500 credits
1000 credits
```

Aisle recommends:

```text
Recommended:
500 Credits
```

Other eligible choices remain available:

```text
Other options:
1000 Credits
```

The recommendation is not an automatic purchase decision.

The customer can choose a larger eligible package instead.

---

## `src/customer-selection.ts`

Records the plan selected by the customer.

The customer may select either:

```text
Recommended Plan
```

or:

```text
Another Eligible Plan
```

The system records whether the selected plan was the recommendation.

```typescript
interface CustomerSelection {
  selectedPlan: CreditPlan;
  wasRecommended: boolean;
}
```

This separates:

```text
Aisle Recommendation
```

from:

```text
Customer Choice
```

---

## `src/approval.ts`

Creates the explicit approval request before any purchase is executed.

The approval request contains:

```text
What
Where
How much
Why
```

Example:

```text
Task:
task-001

Provider:
image-provider

Purchase:
500 Credits

Price:
$20 USD

Reason:
The current task requires 320 additional credits.
```

A customer may approve or reject the request.

A rejected request never reaches the purchase executor.

---

## `src/purchase-executor.ts`

Defines the abstraction used for purchase execution.

```typescript
interface PurchaseExecutor {
  purchase(
    request: PurchaseRequest,
  ): Promise<PurchaseResult>;
}
```

The purchase layer currently distinguishes three outcomes:

```text
SUCCESS

FAILED

UNKNOWN
```

### SUCCESS

The purchase has been confirmed.

```text
SUCCESS
   |
   v
Entitlement Update
   |
   v
Resume
```

### FAILED

The provider explicitly reports that the purchase did not complete.

```text
FAILED
   |
   v
Stop
```

No entitlement update is performed.

The original task is not resumed.

### UNKNOWN

The purchase result cannot be confirmed.

For example:

```text
Network timeout
Provider timeout
Lost response
Connection failure
```

An unknown result is not treated as either success or failure.

```text
UNKNOWN
   |
   v
Stop Safely
```

No entitlement update is performed.

The original task is not resumed.

The system does not automatically perform a duplicate purchase.

---

## `src/mcp-purchase-executor.ts`

Provides an adapter for the future Fast Lane MCP purchase implementation.

The recovery system is intentionally independent of the concrete MCP tool.

The adapter can connect the generic:

```typescript
PurchaseExecutor
```

interface to a real MCP purchase tool such as:

```text
purchase_credits()
```

The actual MCP implementation is not hard-coded into this module until the
real purchase tool interface is provided by the integration team.

---

## `src/mock-purchase-executor.ts`

Provides a fake purchase implementation for local tests.

It does not perform any real payment.

It is used to test the recovery flow before the real MCP purchase tool is
connected.

---

## `src/purchase-flow.ts`

Enforces the approval boundary and routes approved purchases to a
`PurchaseExecutor`.

The purchase flow requires:

```text
Customer Approval
        |
        v
Purchase Guard
        |
        v
Purchase Executor
```

A purchase cannot be executed when:

```text
approved = false
```

---

## `src/purchase-guard.ts`

Prevents duplicate purchases.

A purchase is identified by:

```text
taskId
+
provider
+
planId
```

The first attempt is allowed.

A repeated purchase using the same identity is blocked.

Explicitly failed purchases may be attempted again.

Unknown purchase results remain protected against automatic duplicate
execution because the system cannot confirm whether the original request
completed.

---

## `src/entitlement.ts`

Updates the local entitlement state after a confirmed successful purchase.

Example:

```text
Current balance:
180 credits

Purchased:
500 credits

New balance:
680 credits
```

Only:

```text
SUCCESS
```

can update the entitlement.

Neither:

```text
FAILED
```

nor:

```text
UNKNOWN
```

can increase the balance.

---

## `src/resume.ts`

Creates the information required for the original task to resume after a
successful recovery.

The resume request preserves:

```text
taskId
originalPrompt
purchase result
current entitlement
```

Example:

```text
Purchase:
500 Credits

New balance:
680

Original Task:
Generate an image of a mountain.
```

The actual original-agent execution remains outside this module.

---

## `src/recovery-session.ts`

Tracks the recovery process using explicit states.

The normal successful flow is:

```text
RECOVERY_REQUIRED
        |
        v
PLAN_RECOMMENDED
        |
        v
CUSTOMER_SELECTED
        |
        v
AWAITING_APPROVAL
        |
        v
APPROVED
        |
        v
PURCHASING
        |
        v
PURCHASED
        |
        v
ENTITLEMENT_UPDATED
        |
        v
READY_TO_RESUME
```

Purchase failure paths are:

```text
PURCHASING
    |
    +----> PURCHASE_FAILED
    |
    +----> PURCHASE_UNKNOWN
```

Invalid state transitions are rejected.

This prevents the system from skipping critical recovery or approval stages.

---

## `src/recovery-handler.ts`

Implements the `WakeUpHandler` interface and connects the wake-up system to
the recovery decision layer.

The handler creates a recovery decision from:

```text
FailureEvent
+
Current Credits
+
Task Required Credits
+
Available Credit Plans
```

It then provides the recommendation and alternative purchase options to the
rest of the recovery system.

---

## `src/recovery-orchestrator.ts`

Connects the recovery components into one recovery flow.

The orchestrator handles:

```text
Recovery Decision
        |
        v
Plan Recommendation
        |
        v
Customer Selection
        |
        v
Approval
        |
        v
Purchase
        |
        v
Entitlement Update
        |
        v
Resume
```

It also handles:

```text
Customer Rejection
Purchase Failure
Unknown Purchase Result
No Purchase Required
```

The orchestrator is guarded by the recovery session state machine.

---

# Testing

The project contains unit, integration, and end-to-end tests.

## TypeScript validation

```bash
npx tsc --noEmit
```

## Classifier tests

```bash
node --test --import tsx tests/classifier.test.ts
```

## Error normalization tests

```bash
node --test --import tsx tests/error-normalizer.test.ts
```

## Interceptor tests

```bash
node --test --import tsx tests/interceptor.test.ts
```

## End-to-end tests

```bash
node --test --import tsx tests/end-to-end.test.ts
```

## Run all tests

```bash
node --test --import tsx tests/*.test.ts
```

The current implementation passes the complete automated test suite.

The latest local validation reported:

```text
90 tests
90 passed
0 failed
```

---

# Integration Contract

The wake-up and recovery modules are intentionally independent of the final
purchase implementation.

A downstream recovery system can provide a `PurchaseExecutor`:

```typescript
const purchaseExecutor: PurchaseExecutor = {
  async purchase(request) {
    // Call the real MCP purchase tool
    // or another approved purchase implementation.
  },
};
```

The existing recovery system can therefore support:

```text
Fast Lane
    |
    v
MCP Purchase Tool
```

or:

```text
Slow Lane
    |
    v
Steel Browser
    |
    v
Pricing / Checkout
```

without changing the core recovery decision logic.

---

# Security Considerations

The wake-up and recovery layer should be integrated with additional
safeguards in the complete Aisle system.

## Origin Lock

Purchase destinations should come from trusted configuration or previously
authorized endpoints rather than arbitrary URLs contained in tool output.

## Approval Boundary

The recovery agent should request explicit user approval before spending money.

## Spending Limits

The final recovery system should enforce per-purchase, per-task, and per-day
spending limits.

## Loop Protection

WakeUpManager prevents repeated wake-ups for the same task/tool/failure
combination.

## Purchase Deduplication

The purchase guard prevents the same task, provider, and plan from being
purchased repeatedly.

## Unknown Purchase Results

An unknown payment result must not be treated as a confirmed failure or a
confirmed success.

Automatic duplicate purchasing should not occur when the payment state
cannot be confirmed.

---

# Current Scope

This module currently implements:

```text
Error Detection
Error Normalization
Failure Classification
FailureEvent Creation
Wake-up Dispatch
Duplicate Wake Protection
Context Preservation
Recovery Decision
Credit Requirement Calculation
Purchase Recommendation
Customer Selection
Approval Boundary
Purchase Executor Abstraction
Purchase Deduplication
Purchase Result Handling
Entitlement Update
Resume Request
Recovery Session State
Recovery Orchestration
```

It does not directly implement:

```text
Payment Processing
Stripe Integration
Steel Browser Automation
Pricing Page Navigation
Final User Interface
Original Agent Execution
```

Those components can be connected through the existing integration interfaces.

---

# Project Structure

```text
the logic of agent awake/
|
├── src/
│   ├── event.ts
│   ├── error-normalizer.ts
│   ├── classifier.ts
│   ├── interceptor.ts
│   ├── wakeup-manager.ts
│   ├── recovery.ts
│   ├── purchase-recommender.ts
│   ├── customer-selection.ts
│   ├── approval.ts
│   ├── purchase-executor.ts
│   ├── mock-purchase-executor.ts
│   ├── mcp-purchase-executor.ts
│   ├── purchase-flow.ts
│   ├── purchase-guard.ts
│   ├── entitlement.ts
│   ├── resume.ts
│   ├── recovery-handler.ts
│   ├── recovery-orchestrator.ts
│   └── recovery-session.ts
│
├── tests/
│   ├── classifier.test.ts
│   ├── error-normalizer.test.ts
│   ├── interceptor.test.ts
│   ├── end-to-end.test.ts
│   ├── recovery.test.ts
│   ├── purchase-recommender.test.ts
│   ├── customer-selection.test.ts
│   ├── approval.test.ts
│   ├── purchase-executor.test.ts
│   ├── mcp-purchase-executor.test.ts
│   ├── purchase-flow.test.ts
│   ├── purchase-guard.test.ts
│   ├── entitlement.test.ts
│   ├── resume.test.ts
│   ├── recovery-handler.test.ts
│   ├── recovery-orchestrator.test.ts
│   ├── recovery-session.test.ts
│   └── full-recovery.test.ts
│
├── README.md
├── package.json
├── package-lock.json
└── tsconfig.json
```

---

# Current Development Status

The core Aisle recovery pipeline has been implemented and validated locally.

Completed components:

```text
Wake-up Logic                 ✅
Error Normalization           ✅
Failure Classification       ✅
FailureEvent                 ✅
Interceptor                  ✅
WakeUpManager                ✅
Loop Protection              ✅

Recovery Decision             ✅
Credit Calculation            ✅
Purchase Recommendation       ✅
Customer Selection            ✅
Approval Boundary             ✅

Purchase Executor             ✅
Purchase Guard                ✅
SUCCESS Handling              ✅
FAILED Handling               ✅
UNKNOWN Handling              ✅

Entitlement Update            ✅
Resume Request                ✅
Recovery Session              ✅
Recovery Orchestrator         ✅

Unit Tests                    ✅
Integration Tests             ✅
End-to-End Tests              ✅
```

The current architecture is ready for integration with the remaining Aisle
components.

---

# Remaining Integration Work

The core recovery logic is complete.

The main remaining integration dependency is the real MCP purchase interface:

```text
MCP purchase_credits()
```

Once the real tool schema is provided, the existing
`McpPurchaseExecutor` adapter can be connected without changing the core
wake-up, recovery, recommendation, approval, or resume logic.

Additional product-level integration can then connect:

```text
Customer Approval UI
        |
        v
Real Purchase Executor
        |
        v
Production Entitlement Source
        |
        v
Original Agent Resume
```

---

# Design Principle

Aisle does not replace the original agent.

It wakes up only when the original agent encounters a recoverable
spending-related failure.

```text
Original Agent
      |
      v
Normal execution
      |
      v
Recoverable payment failure
      |
      v
Aisle wakes up
      |
      v
Recovery
      |
      v
Recommendation
      |
      v
Customer approval
      |
      v
Purchase
      |
      v
Original task resumes
```

The original task context is preserved throughout the recovery flow.
