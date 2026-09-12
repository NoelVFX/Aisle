# top-up-agent — Fast Lane

Transaction recovery for coding agents. When a tool call hits a paywall
(`402 / insufficient_credits / quota_exceeded`), this module recovers the task
through the vendor's **WebMCP** purchase tools — no browser required — then
verifies the entitlement and hands back a **resume token** so the host agent
replays the failed call exactly where it stopped.

This package is the **fast lane** only. It runs *inside* a host coding agent
(Hermes / Claude / Codex); the host owns the task, the quote engine, the
approval UX, and the slow-lane browser fallback (Steel + Playwright).

**Wiring this into someone else's orchestrator, quote engine, approval UI, or
the slow lane?** See [`INTEGRATION.md`](INTEGRATION.md) (English) /
[`INTEGRATION.zh-CN.md`](INTEGRATION.zh-CN.md) (中文).

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
import { runFastLane, signMandate, NoFastLaneError } from "top-up-agent";

// The approval/policy layer signs the mandate with a secret only it holds;
// runFastLane is given the same secret to verify against.
const mandate = { ...unsignedMandate, signature: signMandate(unsignedMandate, MANDATE_SECRET) };

try {
  const { verifiedEntitlement, resumeToken } = await runFastLane(
    { checkpoint, quote, mandate },                    // produced upstream + approved
    { session, mandateSecret: MANDATE_SECRET, emit: onEvent }, // session = host's live WebMCP connection
  );
  // Host activates the resume token: replay resumeToken.resumeAction verbatim.
} catch (err) {
  if (err instanceof NoFastLaneError) {
    // Hand off to the slow lane (Steel + Playwright).
  } else {
    throw err; // MandateRejected / PurchaseFailed / PurchaseInFlight / PurchaseVerification
  }
}
```

The host supplies a `WebMcpSession` — a live connection to **one** vendor's
WebMCP surface (`origin`, `provider`, `listTools()`, `callTool()`). This module
never opens connections itself, which keeps it testable: the mock vendor
implements the same interface.

## Connecting to a real vendor

`McpWebMcpSession` implements `WebMcpSession` over the official MCP SDK
(Streamable HTTP transport). It has no purchase logic of its own — it only
turns a real `tools/list` / `tools/call` round trip into the shape the
executor already knows how to drive.

```ts
import { connectMcpWebMcpSession, runFastLane } from "top-up-agent";

// `origin` and `provider` come from TASK CONFIGURATION — never from a tool
// result, a page, or anything the vendor says about itself.
const session = await connectMcpWebMcpSession({
  provider: "higgsfield",
  url: "https://api.higgsfield.ai/mcp",
  headers: { Authorization: `Bearer ${accountScopedToken}` }, // no card data, ever
});

try {
  const result = await runFastLane({ checkpoint, quote, mandate }, { session });
  // ...
} finally {
  await session.close();
}
```

A vendor that wants to be matched by capability rather than tool-name
heuristics should put a `capability: "payment.purchase"` (or
`"payment.balance"`) entry in the tool's `_meta` — the one part of the MCP
`Tool` schema that isn't stripped to a closed set of keys. `annotations` is
validated against a fixed schema on the wire, so a custom field placed there
will not survive transport.

`McpWebMcpSession` accepts a `transport` override for tests — see
`tests/mcp-http-session.test.ts`, which runs the full fast lane against a real
`McpServer` over `InMemoryTransport`, proving the adapter against actual MCP
protocol framing rather than only the hand-written mock.

## Safety properties

- **Signed mandate, really verified** — `runFastLane` requires a `mandateSecret`
  and rejects any mandate whose HMAC-SHA256 signature (`signMandate` /
  `verifyMandateSignature` in `guards.ts`) doesn't match, using a constant-time
  comparison. There is no default secret and no "signature present" free pass.
- **Origin lock** — the WebMCP session's origin must equal the mandate's
  task-configured origin. A vendor may *describe* a purchase; only task
  configuration *authorizes* the origin.
- **Spend ceiling** — a quoted price above `mandate.maximumAmount` is rejected
  before any tool is called.
- **Single-use / idempotent, including in-flight** — one purchase per `(task,
  requirement)`. A retry *after* completion replays the cached result instead
  of buying again; a retry that overlaps a *still-running* attempt throws
  `PurchaseInFlightError` rather than launching a second purchase. A retry
  after a *clean failure* re-claims the slot and tries again.
- **Verify ≠ checkout** — a resume token is issued only after the balance is
  confirmed to cover the need, with three specific failure modes closed:
  - **Ambiguous purchase failures aren't assumed failed.** If the purchase
    call itself errors (network drop, timeout), the balance is checked before
    the attempt is marked `FAILED` — a lost response after the vendor already
    committed the write is recovered instead of clearing the way for a retry
    that would buy twice.
  - **A replayed "already completed" purchase is re-checked, not trusted.**
    If the account no longer holds at least what that purchase was supposed
    to add (spent since, or the record is stale), it throws rather than
    resuming into the same paywall.
  - **Balance reads retry for eventually-consistent vendors** (configurable
    via `verifyRetry`), so a legitimate read-after-write lag doesn't get
    misread as a failed purchase.
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
│   ├── detector.ts           step 1: detect + resolve purchase/balance tools
│   └── mcp-http-session.ts   real WebMcpSession over the MCP SDK (Streamable HTTP)
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
