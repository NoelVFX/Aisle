# top-up-agent

Transaction recovery for coding agents. When a tool call hits a paywall
(`402 / insufficient_credits / quota_exceeded`), this module recovers the task,
verifies the entitlement, and hands back a **resume token** so the host agent
replays the failed call exactly where it stopped.

It runs *inside* a host coding agent (Hermes / Claude / Codex); the host owns
the task, the quote engine, and the approval UX.

Two lanes, one converged outcome:

- **Fast lane** — the vendor exposes **WebMCP** purchase tools; buy directly, no
  browser.
- **Slow lane** — no WebMCP; drive the vendor's real checkout with **Steel Cloud
  + Playwright over CDP**, with a host-injected **computer-use** fallback for
  dynamic pages, and Steel **profile** persistence for authenticated sessions.

Both lanes return the same `RecoveryResult` (`{ lane, verifiedEntitlement,
resumeToken }`), so the host doesn't care which path recovered the task.

```ts
import { runFastLane, runSlowLane, NoFastLaneError } from "top-up-agent";

try {
  return await runFastLane(request, { session });        // WebMCP path
} catch (err) {
  if (err instanceof NoFastLaneError) {
    return await runSlowLane(request, { provider, adapter, profiles, agent });
  }
  throw err;
}
```

## The workflow this implements

```
         (tool call hits 402, host produces Quote + signed Mandate, user approves)
                                     │
                                     ▼
                    ┌────────────────────────────────┐
                    │ 1. Detect WebMCP                │  does the vendor expose
                    │    detectWebMcp(session)        │  purchase + balance tools?
                    └────────────────────────────────┘
                          │ yes                 │ no
                          ▼                     ▼
                 2. Guard (origin lock,    throw NoFastLaneError
                    amount ≤ max,          → host falls back to SLOW LANE
                    signature, expiry)        (Steel + Playwright)
                          │
                          ▼
                 3. Purchase via the vendor's WebMCP tool
                    (args derived ONLY from quote/mandate)
                          │
                          ▼
                 4. Verify entitlement (balance delta re-read)
                          │
                          ▼
                 5. Issue resume token  ──────────►  HERMES replays the
                                                      original failed call
```

## Usage (from the host agent)

```ts
import { runFastLane, NoFastLaneError } from "top-up-agent";

try {
  const { verifiedEntitlement, resumeToken } = await runFastLane(
    { checkpoint, quote, mandate },   // produced upstream + approved
    { session, emit: onEvent },       // session = host's live WebMCP connection
  );
  // Host activates the resume token: replay resumeToken.resumeAction verbatim.
} catch (err) {
  if (err instanceof NoFastLaneError) {
    // Hand off to the slow lane (Steel + Playwright).
  } else {
    throw err; // MandateRejected / PurchaseFailed / PurchaseVerification
  }
}
```

The host supplies a `WebMcpSession` — a live connection to **one** vendor's
WebMCP surface (`origin`, `provider`, `listTools()`, `callTool()`). This module
never opens connections itself, which keeps it testable: the mock vendor
implements the same interface.

## Safety properties

- **Origin lock** — the WebMCP session's origin must equal the mandate's
  task-configured origin. A vendor may *describe* a purchase; only task
  configuration *authorizes* the origin.
- **Spend ceiling** — a quoted price above `mandate.maximumAmount` is rejected
  before any tool is called.
- **Single-use / idempotent** — one purchase per `(task, requirement)`; a
  crashed-and-retried run re-reads balance instead of buying again.
- **Verify ≠ checkout** — a resume token is issued only after the balance is
  confirmed to cover the need.
- **Verbatim replay** — the resume token carries the *original* failed tool
  call; the host does not regenerate the request.

## Slow lane — Steel + Playwright + CDP

```
  no WebMCP  →  create Steel session (resume saved profile)
                     │  chromium.connectOverCDP(session.connectUrl)
                     ▼
              open mandate.origin ──► ORIGIN LOCK (redirect away ⇒ reject)
                     ▼
              discover offers ──► bind to the approved product (ceiling re-checked)
                     ▼
              stage checkout  ──► re-check observed total vs mandate
                     ▼
              confirm (transactional) ──► if result lost: PURCHASE_RESULT_UNKNOWN,
                     │                     re-read balance, never re-click
                     ▼
              verify entitlement ──► balance ≥ requirement
                     ▼
              save profile  →  resume token  →  HERMES
```

- **Browser behind a port.** The worker and adapters talk to `PageLike` /
  `ControlSurface`, never Playwright directly. `SteelBrowserProvider` implements
  them with a live remote browser; `MockBrowserProvider` implements them in
  memory so tests and `npm run demo:slow` need no Steel key and no browser.
- **Deterministic first, model second.** Each vendor has a small
  `VendorPurchaseAdapter` (scripted Playwright). When a step can't complete it
  throws `DeterministicStepError`; the worker hands that sub-goal to a
  host-injected `ComputerUseAgent` and retries once. `createAnthropicComputerUseAgent(client)`
  is a reference loop over an injected Anthropic client (no hard SDK dependency).
- **Profiles.** After authenticating, the session context (cookies/localStorage)
  is saved via a `ProfileStore` (`InMemory` / `File`) and resumed next time.

Real wiring:

```ts
import { SteelBrowserProvider, FileProfileStore, createAnthropicComputerUseAgent } from "top-up-agent";

const provider = new SteelBrowserProvider();           // STEEL_API_KEY
const profiles = new FileProfileStore("./.profiles");
const agent    = createAnthropicComputerUseAgent(anthropicClient);
const adapter  = new HiggsfieldAdapter();              // your VendorPurchaseAdapter
await runSlowLane(request, { provider, adapter, profiles, agent });
```

## Commands

```bash
npm install
npm run demo         # fast lane: mock WebMCP vendor
npm run demo:slow    # slow lane: mock vendor website (no Steel key needed)
npm test             # vitest: both lanes — routing, guards, verify, idempotency, fallback
npm run typecheck
```

## Layout

```
src/
├── index.ts                  public surface (both lanes)
├── types.ts                  shared contracts (Quote, Mandate, Entitlement, ResumeToken, Offer, …)
├── errors.ts                 typed outcomes (NoFastLane / MandateRejected / …)
├── webmcp/                   fast-lane transport
│   ├── session.ts            WebMcpSession interface (host-supplied)
│   └── detector.ts           detect + resolve purchase/balance tools
├── fast-lane/
│   ├── executor.ts           detect → guard → purchase → verify → resume
│   ├── guards.ts             origin lock, ceiling, signature, expiry (SHARED with slow lane)
│   ├── purchase.ts           call the WebMCP purchase/balance tools
│   ├── verify.ts             balance-delta verification
│   └── idempotency.ts        purchase key + store (SHARED with slow lane)
├── slow-lane/
│   ├── executor.ts           browser purchase worker + transaction state machine
│   ├── browser.ts            PageLike / ControlSurface / BrowserProvider ports
│   ├── steel-provider.ts     Steel Cloud + Playwright-over-CDP implementation
│   ├── profiles.ts           ProfileStore (InMemory / File) — Steel profile saving
│   ├── vendor-adapter.ts     VendorPurchaseAdapter interface + chooseMinimumOffer
│   ├── computer-use.ts       ComputerUseAgent + Scripted + Anthropic reference
│   └── adapters/
│       └── mock-vendor-site.ts   in-memory vendor site + adapter + browser
├── resume/
│   └── resume-token.ts       build/validate the handoff artifact
├── mock/
│   └── mock-vendor.ts        in-memory WebMCP vendor (fast lane)
├── demo.ts                   fast-lane walkthrough
└── slow-lane-demo.ts         slow-lane walkthrough
```
