# top-up-agent

The Aisle recovery engine, as a TypeScript library. When an agent's tool call
hits a paywall, Aisle classifies it, freezes a checkpoint, buys the minimum,
verifies the entitlement, and replays the exact call.

For host integration, shared contracts, signing, and vendor MCP requirements,
see [INTEGRATION.md](INTEGRATION.md).

The fast lane can connect to a vendor's MCP endpoint using
`connectMcpWebMcpSession({ provider, url, headers })`. Supply the resulting
session to `runFastLane` and close it in `finally`. Provider and URL come from
trusted configuration. The adapter supports Streamable HTTP and a transport
override for tests; vendor capability hints travel in tool `_meta`.

Task-facing WebMCP calls can use `callWebMcpWithWakeup(session, interceptor,
call)`. It forwards successful calls unchanged and turns MCP tool errors or
thrown HTTP 402 errors into the shared `FailureEvent` → `WakeUpManager` path.
The call requires a config-locked origin and preserves the exact tool name,
arguments, and tool-call ID for recovery and replay.

Fast-lane balance verification accepts `verifyRetry: { attempts, delayMsBetween }`
(default: three reads, 200ms apart). Overlapping attempts raise
`PurchaseInFlightError`; an unconfirmed submission remains blocking until its
entitlement is reconciled. See the integration guide for error handling.

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

const classified = classifyFailure(toolError, { provider: "openrouter" });
const checkpoint = freezeCheckpoint({
  taskId, toolCallId, tool, arguments: args,
  origin: lockOrigin("openrouter", upstreams.openrouter),   // never from the error body
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
├── recovery-flow/            plan recommendation, customer selection, recovery session state machine
├── gateway/                  MCP gateway (stdio + HTTP), recovery coordinator, approval page, Steel purchaser
└── web/                      web path: browsing session, CDP 402 detector, enrollments
```

## Commands

```bash
npm install
npm test              # vitest, all suites
npm run typecheck
npm run smoke:steel   # real Steel: create on new profile → CDP → navigate → release → READY (timed) → restore
```

Environment variables are listed in [`.env.example`](.env.example).

## Steel usage

`SteelBrowserProvider` creates purchase-worker sessions per `steel.md` §4.1:
`useProxy`, `solveCaptcha`, `blockAds` on, 1280×720, 15-minute `timeout`
(asserted with `assertTimeoutApplied`), no `inactivityTimeout`, no
`optimizeBandwidth`. It uses the page Steel already opened and never calls
`newContext()`, sets 90-second timeouts for captcha solves, and releases the
session on every path, including a failed CDP connect.

### Profiles: remembering a vendor login

Every purchase worker runs on a Steel profile (`steel.md` §6), bound per
`(userId, provider)` in a `ProfileStore`. The old auth-context path
(`sessions.context` → `sessionContext`) is gone.

| When | What happens |
|---|---|
| First run | `persistProfile: true` without a `profileId`; Steel creates the profile and the binding is stored immediately, so a failed job can't orphan it |
| Later runs | `profileId` restores the full userDataDir (cookies, storage, IndexedDB, autofill) |
| Session create | throws `STEEL_PROFILE_NOT_CREATED` / `STEEL_PROFILE_NOT_MOUNTED` if Steel didn't mount what was asked |
| Verified outcome | binding gets `lastVerifiedAt`; after release the worker polls `profiles.get` until `READY` (`PROFILE_READY` event) |

**Dedicated IP pin.** A profile created while a dedicated IP is configured
(`dedicatedIpId` or `STEEL_DEDICATED_IP_ID`, a `fixed:…` id from Settings → Network)
records it, and every later session on that profile uses
`useProxy: { type: "fixed", id }`. A restored profile keeps its own IP even if
the configured one changes. A `proxyUrl` that would override a pin throws
`PROFILE_IP_PIN_CONFLICT`. Profiles with no pin still use the rotating residential
pool; `PROFILE_RESTORED.dedicatedIp` shows which.

A `profileId` is credential-tier: events and errors never include it, and
`FileProfileStore` writes owner-only files. Trade-off versus auth context:
Steel persists the profile on release even when the job fails, so a refused or
failed recovery can leave state behind in the profile.

### Computer use: Steel executor, OpenRouter brain

When a discovery or staging step can't complete deterministically, the resolver
takes over, following Steel's Claude Computer Use integration with the brain swapped
for OpenRouter:

| | |
|---|---|
| Executor | Steel `sessions.computer` (screenshots and actions run inside the Steel session) |
| Brain | OpenRouter, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| Keys | `STEEL_API_KEY` + `OPENROUTER_INFRA_KEY` (no Anthropic key) |

```ts
const provider = new SteelBrowserProvider();          // controlSurface: "steel-computer" by default
const agent = createOpenRouterComputerUseAgent();      // Nemotron via OPENROUTER_INFRA_KEY
await runSlowLane(request, { provider, adapter, agent, store, profiles });
```

Set `controlSurface: "playwright"` to execute actions through Playwright over
CDP instead. Override the model with `OPENROUTER_VISION_MODEL` or the `model`
option; it must accept image input. The resolver never clicks the final submit.

## MCP gateway (test it from Codex or Claude Code)

`src/gateway/` is an MCP server over stdio (`server.ts`) or Streamable HTTP
(`http-server.ts`). The agent calls vendor tools through it; a billing wall blocks
the call, opens a recovery, asks for one approval tap, buys through the fast lane
(vendor MCP purchase tools) or the Steel slow lane, and then replays or reports.

```bash
npm run gateway:http    # MCP at http://127.0.0.1:8788/mcp, approvals + web browser at :8787
codex mcp add aisle --url http://127.0.0.1:8788/mcp
claude mcp add --transport http aisle http://127.0.0.1:8788/mcp
```

Set `AISLE_MCP_PORT` / `AISLE_APPROVAL_PORT` if those ports are taken.

| Tool | What it does |
|---|---|
| `openrouter__chat` | Real OpenRouter chat completion with `OPENROUTER_DEMO_KEY` (a $0 account) |
| `openai__chat` | Real OpenAI chat completion with `OPENAI_API_KEY` |
| `aisle__wait_for_recovery` | Blocks again on a recovery that outlived `SAFE_BLOCK_MS` |
| `aisle__spend_report` | Spend and recoveries for this session |

Codex needs `tool_timeout_sec = 300` under `[mcp_servers.aisle]` in `~/.codex/config.toml`.

Try these prompts in Codex or Claude Code:

- *"Use the openrouter chat tool to ask openai/gpt-4o-mini: what is 2+2?"*
- *"Use the openai chat tool to ask: what is 2+2?"*

What happens depends on the vendor's answer:

| Upstream answer | Aisle's behaviour |
|---|---|
| OpenRouter 402 `Insufficient credits` | Recovery → approval → Steel buys credits on `openrouter.ai/settings/credits` (sign-in takeover if needed) → balance rises → original call replayed |
| OpenAI with a no-credit key: 429 `insufficient_quota` | Recovery → approval → Steel stages the top-up and stops at Gate 1 (`STAGED_NOT_SUBMITTED`); the docs rule out real money on OpenAI |
| Any vendor with a blank key: 401 | Not a billing wall. Passed through untouched, no recovery |
| 429 `rate_limit_exceeded` / `Retry-After < 60` | Retry once, never buy |

**Where you watch.** A CLI agent (Hermes, Claude Code or Codex in a terminal) prints one
link, `http://127.0.0.1:8787/browse`, which also opens by itself. That page follows the
latest recovery: the approval card on the right, and after your tap the live Steel browser
on the left with the cursor doing the top-up, plus the timeline. Visual agents (Claude,
ChatGPT) render the same live view in the chat as an MCP App widget (`ui://aisle/recovery.html`);
its button opens `/browse`. The widget never approves: the one tap stays on Aisle's page.
The viewer is read-only except during a takeover. The timeline and logs go
to `.aisle/`. Steel sessions skip proxies and captcha solving unless
`AISLE_STEEL_PROXY_CAPTCHA=1`, since those need a paid Steel balance.

### Demo end to end: Studio on Stripe test mode

`studio` is a small real vendor (`src/demo-vendor/`) that sells image credits through Stripe
Checkout in TEST mode, so the whole flow completes with Stripe's test card 4242 4242 4242 4242
and no real money.

```bash
# .env: STRIPE_SECRET_KEY=sk_test_…   (live keys are refused)
npm run vendor:studio     # site + cloudflared tunnel; saves the login in Steel's credentials vault
npm run gateway:http      # restart so it picks up .aisle/studio.json
```

Ask the agent: *"Generate a hero image with the studio tool."* Studio answers 402
`insufficient_credits`, and Aisle runs the docs' pipeline:

1. **Blocker normalizer → checkpoint freeze** (tool args, origin from config).
2. **Entitlement check:** Studio's `/v1/credits` (OpenRouter: `/api/v1/credits`). Enough already → retry, no purchase.
3. **Quote → policy gate → signed mandate → one tap** on `/browse`.
4. **Slow lane:** Steel signs in with the vaulted login, the cursor picks the pack on `/billing`,
   Gate 1 checks the Stripe Checkout total against the mandate, and deterministic code pays. Stripe
   Checkout shows the test card saved on the customer; if it shows empty card fields instead, the
   public test card is typed, and only on a `cs_test_` session.
5. **Verify entitlement** by reading `/v1/credits` until the balance rises (not the receipt).
6. **Replay** the exact call; the agent gets its image.

OpenRouter and OpenAI use the same pipeline with real cards: `AISLE_REAL_PURCHASE_PROVIDERS`
decides whether Aisle may pay, and Stripe is their only allowed payment origin.

### In your own browser (web path)

Open `http://127.0.0.1:8787/browse`, click **Connect** on `openrouter`, start browsing, and
sign in to a $0 OpenRouter account (never the `OPENROUTER_INFRA_KEY` account). On
`openrouter.ai/chat`, send a message to a paid model. The 402 freezes the page, the approval
card appears beside it, and after the tap a separate Steel browser buys the credits using
your live sign-in. The page reloads when the balance is verified.

### Plan selection and the recovery session

Every recovery carries MO XIA's recovery session (`src/recovery-flow/`). The quote
from `aisle-pipeline.md` stays the recommended plan; other one-time packages that
cover the shortfall and fit the per-purchase ceiling are offered as alternatives.

- The blocked tool result lists `plans.recommended`, `plans.alternatives` and `plans.selected`.
- The approval card (and the web browser card) has a plan chooser. Picking a plan posts
  `POST /r/{id}/select {plan_id}`: the plan is re-gated against every ceiling, the quote is
  rebuilt and the mandate is re-signed, so the tap approves exactly the chosen plan. A plan
  over a ceiling is refused with nothing changed. No changes after approval.
- The session moves `PLAN_RECOMMENDED → CUSTOMER_SELECTED → AWAITING_APPROVAL → APPROVED →
  PURCHASING → PURCHASED → ENTITLEMENT_UPDATED → READY_TO_RESUME`, or ends `PURCHASE_WITHHELD`
  (real-money submit off), `PURCHASE_UNKNOWN` (bought but unverified — never retried) or
  `PURCHASE_FAILED`. Each step is a `SESSION_STATUS` event and shows on the approval page.

The rest of `src/recovery-flow/` (approval records, purchase guard, executors, resume
requests, the standalone orchestrator) is exported as `recoveryFlow` for hosts that run it directly.

## Buying in the Steel browser: the click ladder

After approval, a vendor with a `purchase` block in `upstreams.json` runs the real
slow lane in a Steel browser. The steps follow `aisle-pipeline.md` §17 and §18:

1. **Login check.** The Steel profile for that vendor is restored (on the web path, your live browsing session's sign-in). If it lands on the vendor's sign-in page, Aisle requests a **takeover**: the viewer on the approval page becomes interactive, you sign in there, and Aisle continues in the same session once you're past the login wall (5 minutes max, then read-only again). Steel keeps the sign-in for next time. `npm run steel:login -- <vendor>` does the same ahead of time.
2. **Balance read.** If the balance already covers the task, nothing is bought.
3. **Tier 1.** Offers come from the page's JSON-LD `Offer` blocks, with no clicking and no model.
4. **Tier 2.** Recorded steps replay by accessible role and name. A miss falls back to tier 3.
5. **Tier 3.** The accessibility tree becomes a numbered list, the PICKER model returns one index, and code clicks that node. The steps that reached checkout are saved as a recorded adapter.
6. **Gate 1.** The staged amount, currency, billing period and auto-renew are compared with the signed mandate.
7. **Submit.** Deterministic code clicks the confirm button. A model never sees or clicks a control that pays. If the bank shows 3-D Secure or asks for a code, that is a takeover too: you clear it in the viewer, then Gate 2 decides.
8. **Gate 2.** The balance must rise by the purchased units, then the original call is replayed.

Real-money vendors stop after Gate 1 with `STAGED_NOT_SUBMITTED` unless they are
listed in `AISLE_REAL_PURCHASE_PROVIDERS`.

`.env` in this checkout sets `AISLE_REAL_PURCHASE_PROVIDERS=openrouter`. OpenRouter needs a
card saved on the account: Aisle never types card details.

```bash
npm run steel:credentials -- openrouter   # store the login in Steel's vault; Steel signs in by itself
npm run steel:login -- openrouter         # or: sign the Steel profile in once by hand
```

`steel:credentials` asks for the email and password in your terminal (password hidden) and
sends them to Steel's credentials vault for the vendor's billing origin (steel.md §8). Steel
types them into the sign-in form inside the purchase session; Aisle never sees them. Vendors
opt in with `purchase.steelCredentials: true` (OpenRouter and Studio do). An emailed code, a
passkey or a Google/GitHub sign-in still becomes a scoped takeover.

The tier-3 picker uses `google/gemini-2.5-flash-lite` (fallbacks: llama-3.3-70b, gpt-4.1-nano).
Model calls abort after 60s and retry within the resolver budget.

Recorded adapters, resolver recordings and profile bindings live in `.aisle/`.
`REPLAY_RESOLVER=1` replays recorded picker choices instead of calling the model.

## Not built yet (in the docs, not in this package)

- **The OpenRouter checkout has not been recorded yet.** The first real run goes through
  the tier-3 picker; its button labels and the credits-page balance read are unverified.
- **OpenAI stays staged-only.** `docs/SETUP.md` §4 rules it out for real money (Stripe
  checkout, 3DS, account-security challenges).
- **Higgsfield sells subscriptions on its public pricing page.** Aisle refuses recurring
  billing, so it has no offers until a logged-in credit top-up page is inspected.
- **Receipt upload and trace export** from the Steel session.
- **Control plane** (`apps/api`): durable recovery jobs and the SSE event stream. The
  gateway keeps jobs in memory and its approval page polls.
- **Postgres** (`db/schema.sql`). Stores here are in-memory or files behind interfaces.
- **Steel features the SDK now supports but the code doesn't use yet:** extension
  attach and view-only viewer config. Steel SDK 0.18 has no trace export.
- **Profile READY latency is unmeasured.** `waitForProfileReady` defaults to 60s;
  run `npm run smoke:steel` and set `profileReadyTimeoutMs` from the printed time.
