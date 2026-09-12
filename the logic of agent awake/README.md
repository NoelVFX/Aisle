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
Module Responsibilities
src/error-normalizer.ts
Converts different provider error formats into one predictable representation.
Supported examples include:
{ status: 402, error: "insufficient_credits" }

{ statusCode: 429, code: "quota_exceeded" }

Error("HTTP 402 Payment Required")

"HTTP 402 Payment Required"
Output:
interface NormalizedError {
  status?: number;
  code?: string;
  message?: string;
  raw: unknown;
}
src/classifier.ts
Determines whether an error is recoverable through a payment-related recovery flow.
Recoverable failures currently include:
PAYMENT_REQUIRED
QUOTA_EXCEEDED
INSUFFICIENT_CREDITS
PLAN_REQUIRED
Failures that do not trigger a purchase recovery include:
AUTH_REQUIRED
FORBIDDEN
NOT_FOUND
SERVER_ERROR
UNKNOWN
The classifier prioritizes:
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
src/event.ts
Defines the event passed to the recovery layer.
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
The original agent context is preserved so that recovery can resume the
existing task instead of restarting it from scratch.
src/interceptor.ts
Connects the raw provider error to the wake-up system.
Flow:
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
The interceptor does not purchase anything.
src/wakeup-manager.ts
Controls whether Aisle should wake up.
It provides:
interface WakeUpHandler {
  wake(event: FailureEvent): Promise<void>;
}
The WakeUpManager also provides a loop guard.
For the same:
taskId
+
provider
+
toolName
+
errorType
only one successful wake-up is triggered.
If the recovery handler itself fails, the wake key is removed so another attempt
can be made.
Example
A provider returns:
{
  "statusCode": 402,
  "code": "insufficient_credits",
  "message": "You do not have enough credits."
}
The system converts this into:
INSUFFICIENT_CREDITS
recoverable = true
Then:
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
A different error such as:
{
  "status": 401,
  "code": "unauthorized"
}
is classified as:
AUTH_REQUIRED
recoverable = false
and does not trigger the recovery agent.
Testing
The project contains unit, integration, and end-to-end tests.
TypeScript validation
npx tsc --noEmit
Classifier tests
node --test --import tsx tests/classifier.test.ts
Error normalization tests
node --test --import tsx tests/error-normalizer.test.ts
Interceptor tests
node --test --import tsx tests/interceptor.test.ts
End-to-end tests
node --test --import tsx tests/end-to-end.test.ts
Run all tests
node --test --import tsx tests/*.test.ts
Current test coverage:
25 tests
25 passed
0 failed
Integration Contract
The wake-up module is intentionally independent of the purchase implementation.
A downstream recovery system only needs to implement:
const recoveryAgent: WakeUpHandler = {
  async wake(event) {
    // Purchase credits
    // Open pricing page with Steel Browser
    // Obtain user approval
    // Resume original task
  },
};
This keeps the wake-up logic separate from:
Purchase execution
Browser automation
Payment credentials
User approval UI
Task resumption
Security Considerations
The wake-up layer should be integrated with additional safeguards in the
complete Aisle system.
Origin Lock
Purchase destinations should come from trusted configuration or previously
authorized endpoints rather than arbitrary URLs contained in tool output.
Approval Boundary
The recovery agent should request explicit user approval before spending money.
Spending Limits
The final recovery system should enforce per-purchase, per-task, and per-day
spending limits.
Loop Protection
WakeUpManager prevents repeated wake-ups for the same task/tool/failure
combination.
Current Scope
This module implements:
Error Detection
Error Normalization
Failure Classification
FailureEvent Creation
Wake-up Dispatch
Duplicate Wake Protection
Context Preservation
It does not implement:
Payment Processing
Stripe Integration
Steel Browser Automation
Pricing Page Navigation
User Approval UI
Original Agent Task Resume
Those components can be connected through the WakeUpHandler interface.
Project Structure
the logic of agent awake/
|
├── src/
│   ├── event.ts
│   ├── error-normalizer.ts
│   ├── classifier.ts
│   ├── interceptor.ts
│   └── wakeup-manager.ts
│
├── tests/
│   ├── classifier.test.ts
│   ├── error-normalizer.test.ts
│   ├── interceptor.test.ts
│   └── end-to-end.test.ts
│
├── README.md
├── package.json
├── package-lock.json
└── tsconfig.json
Design Principle
Aisle does not replace the original agent.
It wakes up only when the original agent encounters a recoverable
spending-related failure.
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
Original task resumes
The original task context is preserved throughout the recovery flow.