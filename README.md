# top-up-agent — Fast Lane

Transaction recovery for coding agents. When a tool call hits a paywall
(`402 / insufficient_credits / quota_exceeded`), this module recovers the task
through the vendor's **WebMCP** purchase tools — no browser required — then
verifies the entitlement and hands back a **resume token** so the host agent
replays the failed call exactly where it stopped.

This package is the **fast lane** only. It runs *inside* a host coding agent
(Hermes / Claude / Codex); the host owns the task, the quote engine, the
approval UX, and the slow-lane browser fallback (Steel + Playwright).

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

## Commands

```bash
npm install
npm run demo        # end-to-end run against the mock WebMCP vendor
npm test            # vitest: happy path, routing, guards, verify, idempotency
npm run typecheck
```

## Layout

```
src/
├── index.ts                  public surface
├── types.ts                  shared contracts (Quote, Mandate, Entitlement, ResumeToken, …)
├── errors.ts                 typed outcomes (NoFastLane / MandateRejected / …)
├── webmcp/
│   ├── session.ts            WebMcpSession interface (host-supplied transport)
│   └── detector.ts           step 1: detect + resolve purchase/balance tools
├── fast-lane/
│   ├── executor.ts           orchestrates detect → guard → purchase → verify → resume
│   ├── guards.ts             origin lock, ceiling, signature, expiry
│   ├── purchase.ts           call the WebMCP purchase/balance tools
│   ├── verify.ts             balance-delta entitlement verification
│   └── idempotency.ts        purchase key + store (in-memory default)
├── resume/
│   └── resume-token.ts       build/validate the handoff artifact
├── mock/
│   └── mock-vendor.ts        in-memory WebMCP vendor for tests/demo
└── demo.ts                   runnable walkthrough
```
