# top-up-agent

The Aisle recovery engine, as a TypeScript library. When an agent's tool call
hits a paywall, Aisle classifies it, freezes a checkpoint, buys the minimum,
verifies the entitlement, and replays the exact call.

**North star:** the specs in [`docs/`](docs/) —
[`aisle-pipeline.md`](docs/aisle-pipeline.md) (system) ·
[`steel.md`](docs/steel.md) (browser) ·
[`web-path.md`](docs/web-path.md) (browsing) ·
[`build-checklist.md`](docs/build-checklist.md) (order) ·
`aisle-scaffold.zip` (reference monorepo). Where this README and the docs
disagree, the docs win.

## The pipeline this implements

```
tool call → 402
  → classifyFailure()            429 + Retry-After < 60 is a rate limit, never a wall
  → WakeUpManager                one recovery per (task, requirementHash); infra key never recovered
  → freezeCheckpoint()           args + argumentsHash + origin locked FROM CONFIG
  → buildQuote()                 ALREADY_COVERED | NO_VIABLE_OFFER | smallest one-time package
  → gate()                       origin lock, $50/$100/$250 ceilings, circuit breaker
  → signMandate()                HMAC, 10-min expiry, cap = price × 1.25, one-time, no auto-renew
  → ONE HUMAN TAP                (approval UI not in this package)
  → runFastLane() | runSlowLane()
  → verify by balance delta      checkout success is not entitlement success
  → resumeToken.resumeAction     the gateway replays the same tool with the same arguments
```

```ts
import {
  classifyFailure, freezeCheckpoint, lockOrigin, buildQuote, gate, loadLimits,
  signMandate, runFastLane, runSlowLane, NoFastLaneError,
} from "top-up-agent";

const classified = classifyFailure(toolError, { provider: "mockvendor" });
const checkpoint = freezeCheckpoint({
  taskId, toolCallId, tool, arguments: args,
  origin: lockOrigin("mockvendor", upstreams.mockvendor),   // never from the error body
  blocker: classified.blocker,
});
const q = buildQuote({ checkpoint, current, offers, perPurchaseCeiling: loadLimits().perPurchase });
if (q.kind !== "QUOTE") { /* ALREADY_COVERED → replay; NO_VIABLE_OFFER → refuse */ }
const verdict = gate(q.quote, checkpoint, spend);            // refusal carries cumulative spend
const mandate = signMandate(q.quote, { taskId, recoveryJobId, userId });
// …user approves…
try {
  return await runFastLane({ checkpoint, quote: q.quote, mandate }, { session, store });
} catch (err) {
  if (!(err instanceof NoFastLaneError)) throw err;
  return await runSlowLane({ checkpoint, quote: q.quote, mandate }, { provider, adapter, store, profiles, agent });
}
```

## Invariants (from the docs — do not violate)

1. **Origins come from config or an enrollment row.** Never from a tool result, page,
   error body, or model. The guard anchors on `checkpoint.origin`, and `canonicalize()`
   handles scheme, host case, default port and trailing slash.
2. **A model is never where money moves.** The resolver may recover discovery and
   staging only. A missing confirm control fails with `CONFIRM_NOT_FOUND`; it is never
   handed to the model.
3. **Gate 1 before submit.** Staged amount ≤ cap, currency, one-time, no auto-renew
   (`assertMatchesMandate`). Gate 2 after: `after ≥ before + unitsGranted`.
4. **After submit, never retry.** A lost response becomes `UNKNOWN` and is decided by
   re-reading the balance. Any purchase record not `FAILED` blocks a second purchase for
   the same requirement.
5. **Mandates are single use** (`consumeMandate`) and HMAC-verified by the worker.
6. **Aisle's own OpenRouter key is infrastructure.** A 402 on `OPENROUTER_INFRA_KEY`
   throws `InfraBlockedError` and never opens a recovery job.

## Layout

```
src/
├── index.ts                  public surface
├── types.ts                  contracts: Blocker, LockedOrigin, TaskCheckpoint, Quote, PurchaseMandate, …
├── errors.ts                 NoFastLane / MandateRejected / MandateMismatch / InfraBlocked / …
├── error-normalizer.ts       one error shape for MCP errors and wire responses
├── classifier.ts             429 guard → vendor rules → codes → HTTP status → UNKNOWN
├── interceptor.ts            raw error → FailureEvent → WakeUpManager
├── wakeup-manager.ts         dedupe on requirementHash, infra-key exclusion
├── event.ts                  FailureEvent
├── core/                     checkpoint freeze, canonical hashing + idempotency keys, result helpers
├── quote/                    quote engine
├── policy/                   origin canonicalization, gate, spend ledger
├── mandate/                  sign / verify / Gate 1 comparison
├── webmcp/                   purchase-tool session + detection
├── fast-lane/                executor, guards, purchase, verify, idempotency store
├── slow-lane/                executor, Steel provider, adapters, computer-use resolver, profiles
├── resume/                   resume record
├── mock/                     in-memory vendor with purchase tools
├── demo.ts                   the spine through the fast lane
└── slow-lane-demo.ts         the slow lane against a mock site
```

## Commands

```bash
npm install
npm run demo          # 402 → classify → checkpoint → quote → gate → mandate → fast lane
npm run demo:slow     # slow lane against a mock vendor site (no Steel key)
npm test              # vitest, all suites
npm run typecheck
npm run smoke:steel   # real Steel session: create → assert timeout → CDP → navigate → release
```

Environment variables are listed in [`.env.example`](.env.example).

## Steel usage

`SteelBrowserProvider` creates purchase-worker sessions per `steel.md` §4.1:
`useProxy`, `solveCaptcha`, `blockAds` on, 1280×720, 15-minute `timeout`
(asserted with `assertTimeoutApplied`), no `inactivityTimeout`, no
`optimizeBandwidth`. It uses the page Steel already opened and never calls
`newContext()`, sets 90-second timeouts for captcha solves, and releases the
session on every path, including a failed CDP connect.

## Not built yet (in the docs, not in this package)

- **MCP gateway** (`apps/gateway`): namespacing, the blocking call, `SAFE_BLOCK_MS`,
  `aisle__wait_for_recovery`, replay.
- **Control plane** (`apps/api`): recovery jobs, SSE event stream, `/r/:id` approve/reject.
- **Approval page** (`apps/web`) and the web path (CDP 402 detector, enrollments).
- **Postgres** (`db/schema.sql`). Stores here are in-memory behind interfaces.
- **Tier 1 JSON-LD / Browser Tools markdown offers, tier 3 AX-index picker, adapter
  promotion, `REPLAY_RESOLVER`.**
- **Steel SDK 0.8 gaps:** no Profiles API (profiles use session context instead),
  no trace export, no extension attach. Re-check when upgrading `steel-sdk`.
