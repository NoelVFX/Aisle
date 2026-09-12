# Integration Guide — for teammates wiring up the orchestrator, quote engine, approval UI, or slow lane

This document is for anyone whose code needs to **call into** `top-up-agent`
(the fast lane), or whose code needs to **be called by** whatever wraps it
(the orchestrator). It assumes you have *not* read the fast lane's own source
— only this file, plus pointers into the code where it matters.

If you're building the **slow lane** (Steel + Playwright), skip to
[§5](#5-if-youre-building-the-slow-lane).

---

## 1. What this package is, in one paragraph

`top-up-agent` is a library, not a service. It has one entry point,
`runFastLane(request, deps)`. Given a task checkpoint, a quote, and an
**already-signed, already-approved** purchase mandate, plus a live connection
to one vendor's WebMCP tools, it: detects whether the vendor supports
purchasing via MCP tools, enforces every safety guard, calls the purchase
tool, verifies the entitlement actually landed, and returns a resume token.
It does **not** decide what to buy, does **not** show any UI, does **not**
sign anything, and does **not** know how to talk to a vendor that has no MCP
tools (that's the slow lane's job). Everything upstream of "mandate signed by
a human" and everything downstream of "resume token issued" is someone else's
code — probably yours.

---

## 2. Adding it as a dependency

Three ways to depend on this package, in order of how much hackathon time
they cost:

### Option A — npm/yarn/pnpm workspace (recommended)

If your code lives in the same repo (or we merge repos), add a root
`package.json` with:

```json
{ "workspaces": ["packages/*"] }
```

and move this package to `packages/fast-lane/`. Your code then just does:

```bash
npm install top-up-agent --workspace=your-package
```

and imports work immediately, no publish step, no manual linking. This is
the lowest-friction option and the one worth spending five minutes on.

### Option B — `file:` dependency across separate repos

```json
// your package.json
"dependencies": {
  "top-up-agent": "file:../Top-up-agent-Fast-slow-lane"
}
```

Run `npm install`. Re-run it after every change on this side (or use
`npm link` for a live symlink during active development).

### Option C — git dependency

```json
"top-up-agent": "github:<owner>/Top-up-agent-Fast-slow-lane"
```

Use this once the repo is pushed and you're not actively co-developing both
sides at once.

Whichever option: run `npm run build` in this package first (or point your
bundler at `src/` directly if you're also on `tsx`/ESM-friendly tooling — the
package has zero build step requirements beyond `tsc`).

---

## 3. Public API reference

Everything below is exported from the package root (`import { ... } from
"top-up-agent"`).

### 3.1 The one function you call

```ts
function runFastLane(
  request: FastLaneRequest,
  deps: FastLaneDeps,
): Promise<FastLaneResult>;
```

```ts
interface FastLaneRequest {
  checkpoint: TaskCheckpoint; // where the task stopped
  quote: Quote;               // what to buy
  mandate: PurchaseMandate;   // signed authorization to buy it
}

interface FastLaneDeps {
  session: WebMcpSession;      // live connection to the vendor's MCP tools
  mandateSecret: string;       // REQUIRED — see §4a
  store?: IdempotencyStore;    // REQUIRED in practice — see §4b (defaults to in-memory, which is almost never what you want)
  verifyRetry?: VerifyRetryOptions; // default: { attempts: 3, delayMsBetween: 200 }
  emit?: (event: FastLaneEvent) => void; // for your timeline UI
  now?: () => Date;            // inject for tests only
}

interface FastLaneResult {
  purchaseId: string;
  verifiedEntitlement: Entitlement;
  resumeToken: ResumeToken;
}
```

### 3.2 The shapes you build before calling it

You (or the quote engine / approval UI) construct these — this package never
generates them:

```ts
interface TaskCheckpoint {
  taskId: string;
  agentId: string;
  originalGoal: string;
  failedToolCall: { id: string; tool: string; arguments: unknown }; // replayed VERBATIM later
  origin: {
    provider: string;
    canonicalOrigin: string;       // e.g. "https://api.higgsfield.ai"
    source: "task_configuration";  // only valid value — never derive this from vendor output
    lockedAt: string;
  };
  failure: { type: BlockerType; rawError: unknown };
}

interface Quote {
  provider: string;
  purchase: { productId: string; quantity: number; credits: number; price: number; currency: string };
  billing: "one_time" | "subscription";
  autoRenew: boolean; // must be false — the guard rejects true
  reason: string;
}

interface PurchaseMandate {
  mandateId: string;
  taskId: string;
  origin: string;          // must equal checkpoint.origin.canonicalOrigin
  provider: string;
  productId: string;       // must equal quote.purchase.productId
  maximumAmount: number;   // hard ceiling — quote.purchase.price must not exceed this
  currency: string;
  billingType: "one_time";
  autoRenew: false;
  expiresAt: string;
  nonce: string;
  signature: string;       // see signMandate() below — do not hand-roll this
}
```

### 3.3 Signing (the approval layer's job)

```ts
function signMandate(mandate: Omit<PurchaseMandate, "signature">, secret: string): string;
function verifyMandateSignature(mandate: PurchaseMandate, secret: string): boolean; // used internally by runFastLane; you don't normally call this directly
```

Sign with the **same secret** `runFastLane` will be given in `deps.mandateSecret`. See §4a.

### 3.4 Getting a `WebMcpSession`

```ts
function connectMcpWebMcpSession(options: {
  provider: string;              // must equal mandate.provider
  url: string | URL;             // must equal mandate.origin — take this from task config, never from a tool result
  headers?: Record<string, string>; // e.g. { Authorization: `Bearer ${token}` } — never card data
  clientInfo?: { name: string; version: string };
}): Promise<McpWebMcpSession>;
```

This connects over MCP Streamable HTTP to a real vendor. Call `session.close()`
when you're done with it. If you need a different transport, implement
`WebMcpSession` yourself — it's three methods (`origin`, `provider`,
`listTools()`, `callTool()`).

### 3.5 Errors — what each one means and what to do about it

| Error | What happened | What already occurred | What you should do |
|---|---|---|---|
| `NoFastLaneError` | Vendor has no MCP purchase/balance tools | Nothing — no purchase attempted | Hand off to the **slow lane** with the same `{checkpoint, quote, mandate}` |
| `MandateRejectedError` | A pre-flight guard failed (bad/forged signature, expired, wrong origin, price over ceiling, provider/product mismatch, autoRenew true) | Nothing — no purchase attempted | Don't blindly retry. Something upstream is wrong (stale mandate, tampered quote, wrong secret). Re-derive the mandate from a fresh, correctly-scoped quote and re-approve. |
| `PurchaseInFlightError` | Another call for the exact same `(task, requirement)` is currently running | Unknown — that other call is still in progress | Wait and re-check (poll, or just don't retry immediately). Do **not** loop-retry — that's the exact race this error exists to prevent. |
| `PurchaseFailedError` | The vendor's tool explicitly reported failure | No — vendor said no | Safe to retry (same or fresh mandate, if still unexpired) or re-quote (e.g. price changed). |
| `PurchaseVerificationError` | The purchase call succeeded (or was ambiguous and unrecoverable) but the balance doesn't cover the requirement | **Possibly yes** — money may have moved | Do **not** auto-retry-purchase. This needs a human/ops look, or a fresh top-up quote for the shortfall. Resuming the task now would just re-hit the same paywall. |
| Anything else (raw exception) | Network/transport failure not otherwise classified | Unknown | Treat as transient; standard retry/backoff at the orchestrator level is fine here, since no purchase-side state was mutated ambiguously. |

---

## 4. Three contracts you MUST align with whoever signs mandates and whoever runs the store

Get any of these wrong and things will fail silently or, worse, double-buy.

### 4a. `mandateSecret` — one shared value across two components

Whoever builds the approval UI calls `signMandate(unsigned, SECRET)`.
Whoever calls `runFastLane` passes `deps.mandateSecret = SECRET`. **These
must be the same string**, or every mandate is rejected as forged (correctly
— that's the point of the check).

- Put it in an environment variable, e.g. `MANDATE_SIGNING_SECRET`, read by
  both components from the same source (shared `.env`, shared secrets
  manager — not two people typing "hunter2" into two different files).
- Generate it with `openssl rand -hex 32` or similar. Don't reuse a
  password or an existing API key.
- Never commit it. Never log it. Never put it in a mandate field.

### 4b. `IdempotencyStore` — must be one shared, persistent thing

The default (`new InMemoryIdempotencyStore()`) is **per-process, per-run**.
If your orchestrator creates a new one on every call to `runFastLane` (or
runs as multiple processes/instances), the "don't buy twice" guarantee this
whole package exists to provide **does not hold** — every call looks like a
first-time purchase.

- For a single long-lived orchestrator process handling all recovery jobs:
  create **one** `InMemoryIdempotencyStore()` at startup and pass the same
  instance to every `runFastLane` call. Fine for the demo.
- For anything that restarts, scales horizontally, or needs to survive a
  crash mid-purchase: implement `IdempotencyStore` (three methods — `get`,
  `putIfAbsent`, `update`, see [`src/fast-lane/idempotency.ts`](src/fast-lane/idempotency.ts))
  against Redis or Postgres. **`putIfAbsent` must be atomic** (`INSERT ...
  ON CONFLICT DO NOTHING RETURNING *`, or a Redis `SETNX`-based pattern) — a
  check-then-set built from separate reads and writes reintroduces the exact
  race the interface exists to close.

### 4c. If you're building the orchestrator: match the slow lane's shapes

The switch between fast lane and slow lane should be close to invisible in
your code. Make that true by having both lanes accept the same input and
return the same output shape:

```ts
// What both lanes should accept:
{ checkpoint: TaskCheckpoint, quote: Quote, mandate: PurchaseMandate }

// What both lanes should return on success:
{ purchaseId: string, verifiedEntitlement: Entitlement, resumeToken: ResumeToken }
```

Ask whoever builds the slow lane to `import type { TaskCheckpoint, Quote,
PurchaseMandate, Entitlement, ResumeToken } from "top-up-agent"` rather than
redefining near-identical types — divergence here is how "works when I test
it, fails during the demo" bugs happen.

---

## 5. If you're building the slow lane

You don't need `WebMcpSession` or anything else `top-up-agent`-specific —
your execution model (Steel + Playwright) is completely different. What you
do need:

1. **Accept the same input shape**: `{ checkpoint, quote, mandate }` (import
   the types from this package — see §4c).
2. **Enforce the origin lock yourself.** This package's guard
   (`assertPurchaseAllowed` in [`src/fast-lane/guards.ts`](src/fast-lane/guards.ts))
   is fast-lane-specific plumbing, but the *principle* applies identically to
   you: only navigate to `mandate.origin`, never to a URL that came from a
   tool result or page content. Copy the spirit of that check, not the code.
2b. You should also verify the mandate signature yourself
   (`verifyMandateSignature(mandate, MANDATE_SECRET)`, exported from this
   package) before ever opening a browser — the same forged-mandate risk
   applies to you.
3. **Return the same success shape**: `{ purchaseId, verifiedEntitlement,
   resumeToken }`. Build the `ResumeToken` with the *same* `TaskCheckpoint`
   you were given — the whole point is the host replays the original failed
   call verbatim, not something regenerated.
4. **Verify before declaring success**, exactly like this package does: a
   completed checkout is not a confirmed entitlement. Re-read the vendor's
   balance/account state after checkout before returning success.
5. **Never assume a browser timeout means the purchase didn't happen.**
   Check state before retrying — see [`src/fast-lane/executor.ts`](src/fast-lane/executor.ts)'s
   "ambiguous failure" handling for the fast-lane equivalent of the same
   problem you'll hit with a flaky browser session.

---

## 6. Checklist before you call this "integrated"

- [ ] Package added as a dependency (workspace / `file:` / git) and imports resolve
- [ ] `MANDATE_SIGNING_SECRET` set in one place both the signer and the caller read
- [ ] A single, shared `IdempotencyStore` instance (or a real backend) — not a fresh in-memory one per call
- [ ] A `WebMcpSession` obtained per vendor, `origin`/`provider` sourced from task config, never from tool output
- [ ] Orchestrator branches on all 5 error types per the table in §3.5 — not just a generic `catch`
- [ ] Slow lane accepts/returns the same shapes as fast lane (§4c, §5)
- [ ] `resumeToken.resumeAction` is replayed verbatim back into the host agent's tool-call loop
