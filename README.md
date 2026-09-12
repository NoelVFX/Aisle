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

`src/gateway/` is a local stdio MCP server. The agent calls vendor tools through
it; a billing wall blocks the call, opens a recovery, asks for one approval tap,
runs a Steel session on the locked billing origin, and then replays or reports.

| Tool | What it does |
|---|---|
| `openai__chat` | Real OpenAI chat completion with `OPENAI_API_KEY` |
| `mockvendor__generate_image` | In-process mock that returns 402 until credited |
| `aisle__wait_for_recovery` | Blocks again on a recovery that outlived `SAFE_BLOCK_MS` |
| `aisle__spend_report` | Spend and recoveries for this session |

```bash
codex mcp add aisle --env SAFE_BLOCK_MS=240000 -- "$PWD/node_modules/.bin/tsx" "$PWD/src/gateway/server.ts"
# then in ~/.codex/config.toml under [mcp_servers.aisle]:  tool_timeout_sec = 300
npm run smoke:gateway   # same flow over stdio without Codex, approves automatically
```

Try these prompts in Codex:

- *"Use the openai chat tool to ask: what is 2+2?"*
- *"Generate a hero image with the mock vendor."*

What happens depends on the vendor's answer:

| Upstream answer | Aisle's behaviour |
|---|---|
| OpenAI with a blank key: 401 | Not a billing wall. Passed through untouched, no recovery |
| OpenAI with a no-credit key: 429 `insufficient_quota` | Recovery → approval page → Steel opens `platform.openai.com` → `DRY_RUN_COMPLETE`, nothing bought, no replay |
| OpenAI 429 `rate_limit_exceeded` | Retry once, never buy |
| Mock vendor: 402 `insufficient_credits` | Recovery → approval → Steel opens `https://example.com` → mock credited → original call replayed and succeeds |

The approval page opens in your browser at `http://127.0.0.1:8787/r/{id}`. After you
approve, Steel opens the vendor's billing page from `upstreams.json`, such as
`platform.openai.com/settings/organization/billing/overview`. The live Steel browser
opens in a new tab and is embedded on the approval page. The session stays open for up
to 2 minutes, or until you click **End Steel session**. The viewer is read-only unless
`AISLE_STEEL_INTERACTIVE=1`. The timeline, logs and Steel screenshots go to `.aisle/`. No real money moves: the
gateway never runs a checkout. Its Steel session skips proxies and captcha
solving unless `AISLE_STEEL_PROXY_CAPTCHA=1`, since those need a paid Steel balance.

## Not built yet (in the docs, not in this package)

- **Remote HTTP gateway** (`apps/gateway`): the local gateway is stdio, one per agent
  session. Real purchases through the lanes are not wired into it yet.
- **Control plane** (`apps/api`): durable recovery jobs and the SSE event stream. The
  gateway keeps jobs in memory and its approval page polls.
- **Web path** (CDP 402 detector, enrollments).
- **Postgres** (`db/schema.sql`). Stores here are in-memory behind interfaces.
- **Tier 1 JSON-LD / Browser Tools markdown offers, tier 3 AX-index picker, adapter
  promotion, `REPLAY_RESOLVER`.**
- **Steel features the SDK now supports but the code doesn't use yet:** extension
  attach and view-only viewer config. Steel SDK 0.18 has no trace export.
- **Profile READY latency is unmeasured.** `waitForProfileReady` defaults to 60s;
  run `npm run smoke:steel` and set `profileReadyTimeoutMs` from the printed time.
