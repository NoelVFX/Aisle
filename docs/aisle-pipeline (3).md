# Aisle — Transaction Recovery Layer for Agents

**Full pipeline spec. End to end. Build order, wire formats, Steel usage, demo script.**

---

## 0. How to read this

Anything marked `⚠ VERIFY` is an API detail I could not confirm from current docs. Check it before you build on it. Everything else is either confirmed from Steel's documentation or is your own design surface.

Code is TypeScript unless stated. It is illustrative, not copy-paste — the point is the shape and the ordering, not the syntax.

---

## 1. The whole thing in one paragraph

An agent makes a tool call. The call returns 402 / 429 / 403. Aisle sits in the path, catches it, freezes a checkpoint of the failed call, checks what the user already owns, computes the smallest purchase that clears the shortfall, checks that purchase against a locked origin and three spending ceilings, produces a signed single-use mandate, gets one human tap, executes the purchase through either the vendor's own purchase tool or a Steel cloud browser, verifies the entitlement by reading the balance rather than trusting the receipt, and replays the original tool call with identical arguments. The agent experiences a slow call that succeeded. No restart, no re-prompt, no lost context.

---

## 2. The load-bearing decisions

Four choices decide everything downstream. Get these wrong and nothing else matters.

**2.1 — Aisle is an MCP proxy, not a service the agent calls.**
The agent must not need to know Aisle exists. If you require the agent to call `aisle.recover()`, you've built a library, and CLI agents like Claude Code and Codex will not use it. Instead, Aisle registers as an MCP server, re-exports the wrapped vendors' tools under namespaces, and forwards every call. Interception is structural.

**2.2 — The blocked tool call blocks.**
Do not return a resume token to the agent. Hold the MCP call open, emit progress notifications, and return the real result when recovery completes. The resume token demotes to an internal idempotency key. This is what preserves context — the agent never learns a failure happened.

**2.3 — The origin is captured at checkpoint time, from your own config.**
Never from a tool result, a web page, a model output, or an error body. By the time anything hostile could suggest a URL, the authorized origin is already frozen. The policy gate only compares.

**2.4 — Everything is a projection of one event stream.**
One append-only `events` table keyed by `task_id`. The CLI progress lines, the approval card, the Steel viewer overlay, and the demo timeline are all SSE subscribers. You build the timeline once.

---

## 3. System map

```
                CLI agent                     Browser session
          (Claude Code / Codex)              (user in Steel)
                    │                               │
         MCP tool call → 402            CDP Network.responseReceived → 402
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
                          Blocker normalizer
                       (one BlockerType, both paths)
                                    │
                                    ▼
                            Checkpoint freeze
                    (tool args, goal, ORIGIN, failure)
                                    │
                                    ▼
                          Entitlement check ─────► already covered → retry, no purchase
                                    │
                                    ▼
                              Quote engine
                                    │
                                    ▼
                              Policy gate ────────► refused → halt, report cumulative spend
                        (origin lock + 3 ceilings)
                                    │
                                    ▼
                            Signed mandate
                                    │
                              ONE HUMAN TAP
                                    │
                        ┌───────────┴───────────┐
                        ▼                       ▼
                   Fast lane               Slow lane
              vendor purchase tool      Steel + Playwright
                        └───────────┬───────────┘
                                    ▼
                          Verify entitlement
                        (read balance, not receipt)
                                    │
                                    ▼
                         Replay original call
                      (same args, same tool_call_id)
                                    │
                                    ▼
                            Agent continues
```

---

## 4. Repo layout

```
aisle/
├── apps/
│   ├── gateway/              # MCP proxy server (HTTP transport)
│   │   ├── server.ts
│   │   ├── namespace.ts      # re-export upstream tools, prefixed
│   │   └── intercept.ts      # the try/catch that starts everything
│   ├── api/                  # REST + SSE control plane
│   │   ├── routes/
│   │   └── events.ts
│   ├── worker/               # Steel executor, runs separately
│   │   ├── session.ts
│   │   ├── resolver.ts       # the click-target ladder
│   │   └── adapters/
│   └── web/                  # approval card + viewer + timeline (ONE page)
├── packages/
│   ├── core/                 # state machine, checkpoint, resume
│   ├── detect/               # blocker classifier
│   ├── ledger/               # entitlements
│   ├── quote/                # optimizer
│   ├── policy/               # origin lock, ceilings, circuit breaker
│   ├── mandate/              # sign, verify, consume
│   ├── resolver/             # OpenRouter client, profiles, replay cache
│   └── registry/             # vendor capabilities + recorded adapters
├── extension/                # WebMCP polyfill + in-page widget, packed to .zip
├── mock-vendor/              # your fake SaaS: pricing, checkout, balance
└── db/
    └── schema.sql
```

The gateway and the worker are separate processes. The gateway must stay responsive while a purchase runs for 90 seconds.

---

## 5. How commands are sent — the wire, concretely

### 5.1 Agent → Aisle (CLI path)

Aisle runs as a remote HTTP MCP server. It must be remote, not stdio, because it needs to reach Steel and hold state across processes.

```bash
claude mcp add --transport http aisle https://aisle.yourdomain.dev/mcp \
  --header "Authorization: Bearer $AISLE_KEY"
```

For Codex, the equivalent HTTP MCP entry in `~/.codex/config.toml`. `⚠ VERIFY` the exact key names for your Codex version.

The agent's config points at **Aisle only**. Aisle holds the upstream vendor configs:

```jsonc
// aisle/config/upstreams.json — THIS is the root of trust for origins
{
  "higgsfield": {
    "transport": "http",
    "url": "https://api.higgsfield.ai/mcp",
    "canonicalOrigin": "https://api.higgsfield.ai",
    "billingOrigin": "https://higgsfield.ai",
    "auth": { "env": "HIGGSFIELD_KEY" }
  },
  "openrouter": {
    "transport": "http",
    "url": "https://openrouter.ai/api/mcp",
    "canonicalOrigin": "https://openrouter.ai",
    "billingOrigin": "https://openrouter.ai"
  }
}
```

`canonicalOrigin` and `billingOrigin` are the only values the policy gate will ever accept. Nothing at runtime can add to this file.

### 5.2 Namespacing

On MCP `initialize`, Aisle connects to each upstream, calls `tools/list`, and re-exports everything prefixed:

```ts
// apps/gateway/namespace.ts
for (const [ns, up] of Object.entries(upstreams)) {
  const { tools } = await up.client.listTools();
  for (const t of tools) {
    exposed.push({
      ...t,
      name: `${ns}__${t.name}`,
      description: t.description,
    });
  }
}
// plus Aisle's own:
exposed.push(WAIT_FOR_RECOVERY_TOOL, SPEND_REPORT_TOOL);
```

The agent sees `higgsfield__generate_image`. One config line covers every vendor.

### 5.3 task_id without agent cooperation

CLI agents will not give you a task id. Use the MCP session id, available at `initialize`.

```ts
const taskId = `task_${mcpSessionId}`;
```

For the web path, mint it at `sessions.create` and key on the Steel session id. Both surfaces have a `task_id` from moment zero without the agent knowing anything.

### 5.4 The intercept

```ts
// apps/gateway/intercept.ts
export async function callTool(req: ToolRequest): Promise<ToolResult> {
  const [ns, toolName] = req.name.split("__");
  const up = upstreams[ns];

  await events.emit(req.taskId, "TOOL_CALL_STARTED", { tool: req.name });

  let result: ToolResult;
  try {
    result = await up.client.callTool({ name: toolName, arguments: req.arguments });
  } catch (e) {
    result = toErrorResult(e);
  }

  if (!isError(result)) {
    await events.emit(req.taskId, "TOOL_CALL_SUCCEEDED", { tool: req.name });
    return result;
  }

  const blocker = classify(result, ns);
  if (blocker.type === "UNKNOWN") {
    await events.emit(req.taskId, "TOOL_CALL_FAILED", { tool: req.name, recoverable: false });
    return result;                          // ordinary error, pass it through untouched
  }

  // From here the call does not return until recovery resolves or refuses.
  return await recovery.handleBlocking({
    taskId:     req.taskId,
    toolCallId: req.toolCallId,
    tool:       req.name,
    arguments:  req.arguments,
    origin:     up.canonicalOrigin,         // ← FROM CONFIG. NEVER FROM result.
    billing:    up.billingOrigin,
    blocker,
  });
}
```

### 5.5 The timeout problem, and the fallback

MCP clients cap tool call duration. `⚠ VERIFY` your client's setting (Claude Code exposes a tool-timeout env var; check the current name and default). A human tapping approve on a phone can easily exceed it.

Two-phase design:

```ts
async function handleBlocking(ctx: BlockContext) {
  const job = await createRecoveryJob(ctx);
  const deadline = Date.now() + SAFE_BLOCK_MS;   // stay under client timeout

  while (Date.now() < deadline) {
    await sendProgress(ctx, job);                // keeps the CLI alive and informative
    const state = await job.poll();
    if (state === "RESOLVED") return await replayOriginal(ctx);
    if (state === "REFUSED")  return refusalResult(job);
    await sleep(1000);
  }

  // Handed back without dying. The agent calls wait_for_recovery, which blocks again.
  return {
    isError: false,
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "AWAITING_APPROVAL",
        recovery_id: job.id,
        approve_url: job.approveUrl,
        next: "Call aisle__wait_for_recovery with this recovery_id. Do not re-run the original tool.",
      }),
    }],
  };
}
```

`aisle__wait_for_recovery` does the same loop. The agent can bounce through it indefinitely without ever rebuilding its own context.

**Last line matters.** Without "do not re-run the original tool," a well-meaning agent will retry, hit another 402, and open a second recovery job. Idempotency catches it, but the event stream gets ugly on stage.

### 5.6 Web path — the wire trigger

The user is inside a Steel session, not their own Chrome. You cannot inject into a browser you don't control.

```ts
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");

cdp.on("Network.responseReceived", async ({ response, requestId }) => {
  if (![402, 403, 429].includes(response.status)) return;
  if (!isSameOrigin(response.url, session.lockedOrigin)) return;

  const { body } = await cdp.send("Network.getResponseBody", { requestId });
  const blocker = classifyHttp(response.status, body, session.vendorNs);
  if (blocker.type === "UNKNOWN") return;

  await recovery.create({ taskId: session.taskId, blocker, origin: session.lockedOrigin });
});
```

Do **not** scrape the DOM for "upgrade your plan." Two reasons: it's fuzzy and it's forgeable. The wire signal is the same shape as the MCP signal, which is the entire point — one normalizer, one state machine, two transports.

---

## 6. Blocker detection

HTTP status alone is not enough. Vendors disagree about everything.

```ts
export type BlockerType =
  | "INSUFFICIENT_CREDITS"
  | "QUOTA_EXCEEDED"
  | "PLAN_REQUIRED"
  | "SEAT_REQUIRED"
  | "PAYMENT_REQUIRED"
  | "UNKNOWN";

export interface Blocker {
  type: BlockerType;
  resource: string;          // "image_credits", "seats", "api_calls"
  required?: number;         // parsed if the vendor tells you
  raw: unknown;
}
```

Classify per-vendor first, generic second:

```ts
const VENDOR_RULES: Record<string, Rule[]> = {
  higgsfield: [
    { match: b => b.code === "insufficient_credits",
      type: "INSUFFICIENT_CREDITS", resource: "image_credits",
      required: b => b.required_credits },
  ],
  openrouter: [
    { match: b => /credits/i.test(b.error?.message ?? ""),
      type: "INSUFFICIENT_CREDITS", resource: "usd_balance" },
  ],
};

const GENERIC: Rule[] = [
  { status: 402, type: "PAYMENT_REQUIRED" },
  { status: 429, whenCode: /quota|limit/i, type: "QUOTA_EXCEEDED" },
  { status: 403, whenCode: /plan|upgrade|subscription/i, type: "PLAN_REQUIRED" },
];
```

**429 is genuinely ambiguous.** It's rate limiting as often as it is quota exhaustion, and buying credits does not fix rate limiting. Rule: if the response carries `Retry-After` under 60 seconds, it's a rate limit — sleep and retry, do not open a recovery job. Getting this wrong means Aisle buys credits to solve a problem that would have resolved itself, which is the single most embarrassing possible failure for this product.

---

## 7. Checkpoint

```ts
interface TaskCheckpoint {
  taskId: string;
  agentId: string;
  toolCallId: string;

  originalGoal: string | null;   // null for CLI paths — you don't get it, don't fake it
  tool: string;
  arguments: unknown;
  argumentsHash: string;         // sha256 of canonical JSON

  origin: {
    provider: string;
    canonicalOrigin: string;     // from config
    billingOrigin: string;       // from config
    source: "task_configuration";
    lockedAt: string;
  };

  blocker: Blocker;
  createdAt: string;
}
```

`argumentsHash` uses canonicalized JSON — sorted keys, no whitespace. It appears in three different idempotency keys later, so it has to be stable across processes.

---

## 8. Entitlement ledger

```sql
CREATE TABLE entitlements (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  account_id  TEXT,
  resource    TEXT NOT NULL,     -- 'image_credits', 'seats', 'plan'
  balance     NUMERIC,
  plan        TEXT,
  seats_used  INT,
  seats_total INT,
  renewal_at  TIMESTAMPTZ,
  status      TEXT NOT NULL,     -- active | expired | cancelled
  verified_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, provider, resource)
);
```

**Treat this as a cache, never as truth.** The read order at quote time is:

1. Read the row. If `verified_at` is older than 60 seconds, refresh it.
2. Refresh via the vendor's balance tool if the capability registry has one, else via a Steel read-only page load.
3. If refreshed balance already clears the shortfall → emit `ALREADY_COVERED`, skip the entire purchase path, replay the original call.

Step 3 is the differentiator. A DOM-scraping shopping agent structurally cannot do it, and it is one of the two moments in the demo where Aisle *doesn't* buy something.

**Spend-down, if you have time:** the same table answers "which seats are unused." `seats_used < seats_total - 1` on a paid plan is a downgrade recommendation. Costs you one query and it's the only part of the product that saves money instead of spending it. Good closing slide, bad use of hour four.

---

## 9. Quote engine

```
minimize  price
subject to  balance_after >= required
            price <= per_purchase_ceiling
            task_spend + price <= per_task_ceiling
            daily_spend + price <= per_day_ceiling
            purchase.origin == checkpoint.origin.billingOrigin
```

```ts
interface Quote {
  provider: string;
  productId: string;
  quantity: number;
  unitsGranted: number;
  price: number;
  currency: string;
  billing: "one_time" | "subscription";
  autoRenew: boolean;
  reason: string;          // rendered verbatim on the approval card
}
```

Rules that are not negotiable:

- **Prefer `one_time` over `subscription`** even when the subscription is cheaper per unit. The user is unblocking a task, not adopting a vendor.
- **`autoRenew: false` always.** If the flow can't be configured that way, say so on the card in plain language rather than silently enrolling someone.
- **If the only package is wildly oversized** (needs 3,200, smallest pack is 100,000 for $400), that's not a quote, that's a refusal. Say the minimum viable purchase exceeds the ceiling and stop.

`reason` is user-facing prose: *"3 hero images at 1,067 credits each = 3,200. Balance 0. Smallest pack that clears it is 5,000."* Write it in the engine, not the UI.

---

## 10. Policy gate

Four checks, in this order, before a mandate is ever signed.

```ts
export function gate(quote: Quote, cp: TaskCheckpoint, spend: SpendState): GateResult {
  // 1. Origin lock — a hard boundary, not a heuristic
  if (canonicalize(quote.origin) !== canonicalize(cp.origin.billingOrigin)) {
    return refuse("ORIGIN_VIOLATION", {
      attempted: quote.origin,
      authorized: cp.origin.billingOrigin,
    });
  }

  // 2. Per purchase
  if (quote.price > LIMITS.perPurchase) return refuse("PER_PURCHASE_CEILING", { ... });

  // 3. Per task
  if (spend.task + quote.price > LIMITS.perTask) return refuse("PER_TASK_CEILING", {
    cumulative: spend.task, requested: quote.price, remaining: LIMITS.perTask - spend.task,
  });

  // 4. Per day
  if (spend.day + quote.price > LIMITS.perDay) return refuse("PER_DAY_CEILING", { ... });

  // 5. Circuit breaker
  if (spend.attempts >= MAX_PURCHASE_ATTEMPTS_PER_TASK) return refuse("CIRCUIT_OPEN", {
    attempts: spend.attempts, cumulative: spend.task,
  });

  return { ok: true };
}
```

Defaults: `perPurchase $50`, `perTask $100`, `perDay $250`, `MAX_PURCHASE_ATTEMPTS_PER_TASK 3`.

**A refusal always reports cumulative spend.** "Blocked" is a dead end. "Blocked — you've spent $50 on this task, this would take it to $130, ceiling is $100" is a product. The refusal payload goes back to the agent as a normal tool result so the agent can tell the user something useful instead of dying.

`canonicalize()` must handle scheme, trailing slash, port, and case. Do not write `===` on raw strings and call it an origin lock.

---

## 11. Mandate

```ts
interface PurchaseMandate {
  mandateId: string;
  taskId: string;
  recoveryJobId: string;

  billingOrigin: string;
  provider: string;
  productId: string;
  quantity: number;

  maximumAmount: number;       // the CAP, may exceed quote.price slightly for tax
  currency: string;
  billingType: "one_time";
  autoRenew: false;

  expiresAt: string;           // 10 minutes. Approval is a live decision.
  nonce: string;
  signature: string;           // HMAC over the canonical serialization
}
```

- **Single use.** Consumed atomically at execution: `UPDATE mandates SET status='consumed' WHERE id=$1 AND status='approved' RETURNING *`. Zero rows returned means someone already used it — abort, do not purchase.
- **Signed, and verified by the worker.** The worker is a separate process. It must not trust its own input.
- **`maximumAmount` is a cap, not a price.** Tax and currency conversion move the real number. The comparison at checkout is `actual <= maximumAmount`, never `actual === quote.price`.
- **The worker never receives a card number.** It receives the mandate. Payment instruments live in Steel.

---

## 12. Approval — one URL, three things

The URL printed to the CLI, pushed to the phone, and rendered in the web widget is the same URL:

```
https://aisle.dev/r/{recovery_id}
```

It renders three panes off one SSE subscription:

1. **The approval card** — amount, credits, one-time, no auto-renew, what it unblocks, the billing origin, and all three remaining ceilings.
2. **The Steel live viewer** — embedded, so the user watches the browser that will spend their money.
3. **The event timeline** — the same stream the CLI is printing.

The card is not asking "may the agent shop." It is asking "shall this exact transaction happen." Every field on it is a field in the mandate. If a field isn't in the mandate, it doesn't belong on the card.

```
POST /r/{id}/approve   { mandate_signature }   → 204
POST /r/{id}/reject    { reason? }             → 204
GET  /r/{id}/events                            → text/event-stream
```

Approval is idempotent on `approval:{mandateId}`. Double-tap on a flaky phone connection must not double-buy.

---

## 13. Lane router

```ts
interface VendorCapabilities {
  provider: string;
  purchaseCredits?: { toolName: string };
  subscribeToPlan?: { toolName: string };
  getBalance?:      { toolName: string };
  recordedAdapter?: { version: number; steps: AdapterStep[] };
}
```

Route order:

1. Native MCP purchase tool present → **fast lane**.
2. WebMCP tools declared on the billing page → **fast lane** (via the extension polyfill).
3. Recorded adapter present and version matches → **slow lane, deterministic replay**.
4. Nothing → **slow lane, cold resolution**, and record an adapter on success.

Step 4 → step 3 is the promotion loop. It is the thing that makes the second run fast, and the thing worth demoing by running the same vendor twice.

---

## 14. Fast lane

```ts
const res = await up.client.callTool({
  name: caps.purchaseCredits.toolName,
  arguments: {
    product_id: mandate.productId,
    quantity: mandate.quantity,
    idempotency_key: `purchase:${taskId}:${requirementHash}`,
  },
});
```

Seconds, not minutes. Then it converges with the slow lane at verification — **the fast lane does not get to skip verification.** A purchase tool returning `{success: true}` is a claim, not an entitlement.

---

## 15. Slow lane — full Steel usage

This section maps every Steel capability to a concrete job in the pipeline.

### 15.1 Session creation — what must be decided before the socket exists

Proxy, stealth/fingerprint, and which profile is mounted are all set at create time and cannot be changed afterward. That means the locked origin is an input to `sessions.create`, not just to the policy gate. One value, two enforcement points.

```ts
const session = await steel.sessions.create({
  profileId,                  // from your (user, provider) → profileId table
  persistProfile: true,       // ← without this, nothing is remembered
  useProxy: true,
  solveCaptcha: true,
  timeout: 15 * 60 * 1000,    // ⚠ VERIFY param name. Default is 5 min — too short.
  // proxyUrl: dedicatedIp,   // pin the same egress IP to the same profile
  // region: "us-east",       // ⚠ VERIFY. Match the account's billing region.
});

const browser = await chromium.connectOverCDP(
  `wss://connect.steel.dev?apiKey=${STEEL_KEY}&sessionId=${session.id}`
);
const context = browser.contexts()[0];
const page    = context.pages()[0];    // Steel gives you a page already open
```

**The timeout is a demo-killer.** Your flow deliberately parks a live session while a human taps approve on a phone. The default five-minute session timeout will expire underneath you. Set it explicitly.

### 15.2 Profiles — "remembering"

Steel's Profiles API stores a snapshot of the full Chromium user data directory: cookies and localStorage for every origin visited, live login sessions, IndexedDB, installed extensions and their config, autofill, history, bookmarks, and site permissions. You store one `profileId` per `(user_id, provider)` and hand it back on create.

```sql
CREATE TABLE vendor_profiles (
  user_id      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  profile_id   TEXT NOT NULL,       -- Steel's
  dedicated_ip TEXT,                -- pin with the profile
  last_ok_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, provider)
);
```

**Pin the profile and the IP together.** This is Steel's own guidance: profiles preserve browser identity, dedicated IPs preserve network identity, and for account-based agents the strongest setup is one profile plus one dedicated IP per account, so sites see the same cookies and a familiar IP instead of a fresh browser from a new network every run. Restoring week-old cookies from a new egress IP looks exactly like a hijacked session, and you get challenged — making "remembering" actively worse than starting cold.

**The write happens on release, not during the run.** Steel persists the userDataDir after the session is released, moving the profile through `UPLOADING` → `READY`.

```ts
try {
  await runPurchase(page, mandate);
} finally {
  await browser.close();
  await steel.sessions.release(session.id);     // ← REQUIRED or nothing is saved
}
await waitForProfileReady(profileId);           // before any second run
```

Skipping release keeps the browser alive until the timeout and delays the snapshot. If your demo runs the same vendor twice back to back, the second run will load a stale profile unless you wait for `READY`.

**Liveness probe before you rely on it.** Cookies expire on their own schedule.

```ts
await page.goto(`${billingOrigin}/account`);
if (!(await page.getByTestId("account-email").isVisible())) {
  await reAuthenticate(page);   // Credentials API path
}
```

Do this *before* navigating to checkout. Discovering you're logged out at the card step is the worst place to discover it.

**Profiles accumulate in place; they do not fork.** Anyone who can call `sessions.create({ profileId })` on your workspace drives a browser logged in as that user. If you want a refused or failed job to leave zero residue, use the lighter auth-context path instead:

```ts
const sessionContext = await steel.sessions.context(session.id);   // plain JSON
const next = await steel.sessions.create({ sessionContext });
```

That snapshot is cookies and localStorage only, it's yours to store and diff, and it decays faster — usable today, often not next week, rarely next month. Trade-off: profiles remember more, auth-context isolates better.

### 15.3 Proxies

Below Chrome at the network layer, which means Playwright can neither see nor change the egress. That's a feature: a compromised page script cannot exfiltrate around your proxy config. Set `useProxy: true`, or pin a dedicated IP per profile as above.

### 15.4 Stealth and fingerprint

Launch flags and patched Chrome internals, applied before your socket exists. Nothing to do at runtime. The only thing you control is not undermining it: don't rotate the fingerprint between runs on the same profile.

### 15.5 Extensions — your WebMCP polyfill lives here

This retires the risk you flagged about `document.modelContext` not existing in the Steel browser. Extensions are uploaded once as `.zip`/`.crx` (or pulled from the Chrome Web Store), stored globally against your organization, and attached to any session.

```
extension/
├── manifest.json
├── polyfill.js      # spec-shaped document.modelContext shim
└── widget.js        # in-page approval card for the web path
```

```ts
await steel.extensions.upload({ file: fs.readFileSync("extension/aisle.zip") });
// then attach on session create — ⚠ VERIFY the attach param name
```

Ship it as an extension rather than `Page.addScriptToEvaluateOnNewDocument`. It survives redirects and navigations, it's one upload per org rather than per session, and it's the same mechanism for both the CLI-spawned session and the web-app session. **Verify this works before the hackathon, not at H+0.**

### 15.6 Captcha

Set `solveCaptcha: true`; there's also a dedicated Captchas API. The sidecar watches the session and resolves asynchronously.

**This changes your timeouts.** A captcha pause is tens of seconds inside an otherwise sub-second step. Every Playwright wait in the checkout path needs to tolerate it:

```ts
await page.getByRole("button", { name: /complete purchase/i })
          .click({ timeout: 90_000 });
```

Default 30-second waits will fail mid-solve and you'll retry into a half-submitted checkout.

### 15.7 Credentials API

Stores username and password; Steel re-authenticates each session by filling the login form. Works for any site with a standard form, at the cost of running the login UI every session. Credentials never enter your process and never enter a model prompt.

Use credentials for stable long-lived account access; use auth-context when the site uses SSO, MFA, or magic links that the vault can't drive.

`⚠ VERIFY — this is load-bearing for your pitch.` The Credentials API is documented for **login forms**. Whether the vault will hold and type **card fields** is a separate question, and your safety line ("Steel types the card, it never enters our process") depends on it. Check this week. Fallback: Stripe test mode on your mock vendor, and adjust the claim on stage to match what the demo actually does. Do not say the sentence if the demo doesn't do the thing.

### 15.8 Files API

Session files plus global files, with automatic preservation of files from completed sessions. This is how you deliver on "the purchase doesn't end at checkout."

Capture on the confirmation page:

- invoice / receipt PDF
- license key file
- any download the vendor triggers

```ts
const download = await page.waitForEvent("download");
// persist through Steel so it outlives the session
await steel.sessions.files.upload(session.id, { file: await download.path() });
```

Attach the resulting file ids to the `purchases` row. Now "here's your license key" is part of the resume payload instead of something lost when the browser died.

### 15.9 Browser Tools

Steel exposes APIs to convert pages to markdown, readability, screenshots, or PDFs.

**This is your quote engine's input.** Do not scrape the pricing DOM. Convert the pricing page to markdown, hand that to the model with the requirement, get back a structured package list. Far more robust across vendor redesigns than selectors, and much cheaper than screenshots.

Use the PDF/screenshot output on the confirmation page as the receipt artifact.

### 15.10 Agent Traces

Has its own API with a timeline and exports, not just a viewer. Export the trace at job completion and attach it to the `purchases` row.

This converts your safety story from a claim into a file. "Here is exactly what it clicked, in order, with timings" beats "here's a video" in any technical Q&A.

### 15.11 Human-in-the-Loop / takeover

A documented session control. **This is the demo beat you're missing.**

When checkout throws 3DS, an OTP, or anything the automation cannot legitimately clear:

```ts
if (await detect3DS(page)) {
  await events.emit(taskId, "TAKEOVER_REQUESTED", { viewerUrl: session.sessionViewerUrl });
  await waitForHumanToClear(page, { timeout: 5 * 60_000 });
}
```

You don't fail, and you don't fake it — you hand the user the wheel in the same session, then resume. That's a third place Aisle says no, and it's the most honest one. It also happens to be the answer to the inevitable "what about bank verification" question from a judge.

### 15.12 Embed / viewer

Two embed types: live streaming over WebRTC (headful by default), and replay of recorded sessions. There's also a Fullscreen Mode. `session.sessionViewerUrl` is on the create response.

Live embed powers the approval page. Replay powers the post-hoc audit view. The viewer is a read-only second consumer, so putting it on stage does not perturb the run.

### 15.13 Multi-region

Matters more than it looks for a purchasing product. Buying from a region that doesn't match the billing address is both a currency problem and a fraud-flag problem. Set the region to match the account.

### 15.14 Steel CLI and skills

`steel forge <recipe>` scaffolds starter projects locally. Steel also publishes skills — `steel-developer`, `steel-reliability`, `steel-session-debugging`, `steel-skill-creator`. Installing them into Claude Code costs five minutes and shows sponsor fluency in the writeup.

### 15.15 Not using

Selenium mode, Puppeteer, Mobile Mode, self-hosting. Nothing in this flow needs them. Steel Local is worth knowing only as a way to develop without burning cloud session credits.

---

## 16. The model layer — OpenRouter

Steel opens the browser. It does not decide what to click. That decision needs a model, and the model is served through OpenRouter.

### 16.1 Where a model is actually used

Three places. Everything else in this pipeline is deterministic and must stay that way.

1. **Tier-3 cold resolution** — picking an index out of the AX candidate list (§17). Text-only, cheap, no vision needed.
2. **Pricing page → structured packages** — markdown in from Browser Tools, JSON package list out, feeding the quote engine.
3. **Adapter repair** — when a tier-2 locator misses and you need to re-resolve and re-record.

A model is **never** in: the final submit, the policy gate, the origin decision, the mandate comparison, or the entitlement verification. If a model output can change whether money moves, you've built it wrong.

### 16.2 Why OpenRouter and not a direct provider key

- One key, many models, chosen per call. The node-picker wants something cheap and fast; the vision fallback wants something else entirely. Same endpoint, no second integration.
- The `models` array gives automatic failover: if your primary is down, rate-limited, or refuses on moderation, OpenRouter tries the next model in priority order rather than failing your purchase mid-flow. On a demo stage that is the difference between a pause and a dead run.
- Credit balance is inspectable, which means your own resolver budget can be a line in the timeline.

### 16.3 Wiring

OpenAI-compatible. Base URL `https://openrouter.ai/api/v1`, endpoint `/chat/completions`, `Authorization: Bearer`. Attribution headers `HTTP-Referer` and `X-OpenRouter-Title` are optional and only affect your dashboard analytics.

```ts
// packages/resolver/client.ts
import OpenAI from "openai";

export const resolver = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey:  process.env.OPENROUTER_INFRA_KEY,     // ← NOT the demo vendor key. See 16.5.
  defaultHeaders: {
    "HTTP-Referer": "https://aisle.dev",
    "X-OpenRouter-Title": "Aisle",
  },
});
```

Fallback chain. Provide model IDs in priority order; if the first errors, the next is tried. Requests are priced using the model that was ultimately used, which comes back in the `model` field of the response — log it, because your cost attribution is otherwise a guess.

```ts
const PROFILES = {
  // structured index selection + package extraction — text only
  PICKER: {
    model: "anthropic/claude-sonnet-4.6",
    extra_body: { models: ["openai/gpt-5-mini", "google/gemini-3-flash-preview"] },
  },
  // true computer-use fallback: canvas checkout, cross-origin iframe, AX tree useless
  VISION: {
    model: "anthropic/claude-sonnet-4.6",
    extra_body: { models: ["openai/gpt-5"] },
  },
} as const;

const res = await resolver.chat.completions.create({
  ...PROFILES.PICKER,
  messages: [{ role: "user", content: prompt }],
  response_format: { type: "json_object" },
});
await events.emit(taskId, "RESOLVER_CALLED", {
  profile: "PICKER",
  modelUsed: res.model,            // may differ from requested — that's the fallback working
});
```

Via the OpenAI SDK the `models` array goes in `extra_body`, since it isn't part of the OpenAI schema. `⚠ VERIFY` the current model slugs against the live catalogue — they move, and a stale slug fails at 2:01 into the demo.

### 16.4 Constrain the output

The picker returns an integer, not prose and not a selector.

```ts
const prompt = `Requirement: ${requirement}
Candidates:
${candidates.map(c => `[${c.index}] ${c.role} "${c.name}" near: ${c.near}`).join("\n")}

Return ONLY: {"index": <number>, "why": "<12 words max>"}`;
```

Validate the returned index against `candidates.length` before you touch the page. A model returning `[47]` when you gave it 12 candidates is a bug you want to catch in your code, not in Chrome.

### 16.5 The self-reference trap — read this twice

OpenRouter appears in this project **twice**, and conflating them will deadlock you live on stage.

- **OpenRouter as a user vendor.** The user's own OpenRouter credits, consumed by their task. Hits 402 → fully recoverable, this is a headline demo case.
- **OpenRouter as Aisle's resolver.** The model that decides what to click. If *this* balance hits 402, Aisle needs a model in order to recover... in order to buy model credits. Infinite regress, and the recovery layer cannot recover itself.

**Hard rule: the model provider driving recovery is infrastructure, not a recoverable vendor.**

```ts
// Key the exclusion on the API KEY IDENTITY, not the provider name.
// "openrouter" is both things. Only the key tells them apart.
const NON_RECOVERABLE_KEYS = new Set([hash(process.env.OPENROUTER_INFRA_KEY!)]);

if (NON_RECOVERABLE_KEYS.has(keyHash)) {
  await events.emit(taskId, "INFRA_CREDITS_EXHAUSTED", { provider: "openrouter" });
  throw new InfraBlockedError(
    "Resolver credits exhausted. Aisle cannot recover its own resolver. Top up manually."
  );
}
```

Practical consequences:

- Two OpenRouter accounts, or at minimum two keys: `OPENROUTER_INFRA_KEY` and whatever the demo vendor uses.
- Pre-fund the infra key before the hackathon and check it the morning of.
- The entitlement ledger must **not** merge these into one `provider = 'openrouter'` row. Key on `(user_id, provider, account_id)` and treat the infra account as a different `account_id` entirely.
- Fail loud and distinctly. `INFRA_BLOCKED` is not `PAYMENT_REQUIRED`, and it must never open a recovery job.

### 16.6 Resolver budget guard

Tier 3 runs a model inside a purchase flow, which is exactly where a confused loop is most expensive and most visible. Add a fourth ceiling to the circuit breaker:

```
MAX_RESOLVER_CALLS_PER_JOB = 5
```

Exceeded → the job fails as `RESOLUTION_EXHAUSTED`. It does not fall back to "try clicking things." Resolver spend is yours, not the user's, so it does **not** count against the task ceiling — but it does get its own cap, and it gets reported in the trace.

### 16.7 Make the demo not depend on a model call

The single most fragile second of your run is a live model call at 2:01 with conference wifi.

Record resolver outputs on the rehearsal run and gate the live call behind an env flag:

```ts
if (process.env.REPLAY_RESOLVER === "1") {
  return recordedChoices[`${billingOrigin}:${stepIndex}`];
}
```

Rehearse with `REPLAY_RESOLVER=0` so the recordings are real. Present with `REPLAY_RESOLVER=1`. Tier 2 replay covers the same ground on a warm vendor anyway, so the only path that needs a live model is the deliberately cold one — run that path first in rehearsal, then let the recording carry it.

---

## 17. Click-target resolution — how it knows where to click

Four tiers, tried in order, stop at the first hit.

### Tier 0 — Don't touch a page
Native MCP purchase tool. Fast lane. No DOM at all.

### Tier 1 — The page declares itself
WebMCP tools via your polyfill extension. Also — and people forget this — a lot of SaaS pricing pages already ship schema.org `Offer` JSON-LD with price, currency, and billing period. That's your quote input with zero clicking and zero model calls. Check for it first.

```ts
const offers = await page.$$eval('script[type="application/ld+json"]', els =>
  els.map(e => JSON.parse(e.textContent!)).filter(o => /Offer|Product/.test(o["@type"]))
);
```

### Tier 2 — Recorded adapter
Deterministic Playwright replay of stored locators, keyed by `(billingOrigin, adapterVersion)`. This is where you want to be 95% of the time in production and on the second demo run.

### Tier 3 — Cold semantic resolution

**Never ask a model for a CSS selector.** It will produce a plausible one that doesn't exist and you'll spend twenty minutes debugging a hallucination.

Build a numbered index of real, actionable nodes and make the model return an index:

```ts
const { nodes } = await cdp.send("Accessibility.getFullAXTree");

const candidates = nodes
  .filter(n => ACTIONABLE_ROLES.has(n.role?.value))
  .map((n, i) => ({
    index: i,
    role:  n.role?.value,
    name:  n.name?.value,
    near:  nearestPriceText(n),      // walk up 2 ancestors, grab $-bearing text
    backendNodeId: n.backendDOMNodeId,
  }));

const choice = await model.pick({
  requirement: "need 3,200 image credits, buy the smallest pack that clears it",
  candidates: candidates.map(c => `[${c.index}] ${c.role} "${c.name}" near: ${c.near}`),
});                                   // returns: 17

await clickBackendNode(cdp, candidates[choice].backendNodeId);
```

The model emits an integer. It cannot point at nothing. The worst failure mode is picking the wrong *real* button — and §18 makes that safe.

Reading and targeting are different jobs: markdown via Browser Tools for *what the packages are*, the AX index for *what to click*.

### Promotion — tier 3 becomes tier 2

Don't store the AX index; it's position-dependent and worthless next run. Derive a durable locator from the node you actually clicked, preferring accessible-name locators over CSS paths because names survive redesigns and class hashes don't.

```ts
adapter.steps.push({
  action: "click",
  locator: { role: "button", name: candidates[choice].name },   // getByRole
  fallback: { css: cssPath },
});
await registry.saveAdapter(billingOrigin, adapter);   // version++
```

On a tier-2 selector miss, don't fail the job — fall back to tier 3, re-record, bump the version. **The fallback is the recording mechanism.**

### Where the page comes from

Not the 402 body. Error payloads often include a helpful billing URL, and that's precisely the injection vector. Treat it as a hint only: compare its host to the locked `billingOrigin`, discard on mismatch, otherwise navigate from the locked origin's root.

---

## 18. Verification — why a wrong click is safe

Two gates, and neither trusts that the click was correct.

**Gate 1 — staged checkout vs mandate, field by field:**

```ts
const staged = await adapter.readStagedCheckout(page);
// { lineItem, amount, currency, billingPeriod, autoRenew }

assert(staged.amount        <= mandate.maximumAmount, "AMOUNT_EXCEEDS_MANDATE");
assert(staged.currency      === mandate.currency,     "CURRENCY_MISMATCH");
assert(staged.billingPeriod === "one_time",           "UNEXPECTED_SUBSCRIPTION");
assert(staged.autoRenew     === false,                "AUTO_RENEW_ENABLED");
```

Mismatch aborts before submit. **The final submit is executed by deterministic code only after this comparison passes — never by the model path.** So the worst case of a bad tier-3 pick is a failed job, not a wrong purchase.

Put the mandate and the parsed checkout side by side in the trace right before the click lands. That's the cleanest single frame in the whole demo.

**Gate 2 — entitlement, after:**

```ts
const before = ledger.balanceBefore;
const after  = await refreshBalance(provider);        // re-read the vendor
if (after < before + quote.unitsGranted) throw new PurchaseVerificationError();
```

Checkout success is not entitlement success. The worst possible state is Aisle believing it bought credits while the task still can't run.

**The unknown-result case.** Playwright times out after submit and you genuinely don't know whether the card was charged. **Never retry.** Re-read the balance and the vendor's transaction list, and decide from observed state.

```
PURCHASE_SUBMITTED → PURCHASE_RESULT_UNKNOWN → VERIFY → (COMPLETED | FAILED)
```

There is no edge from `UNKNOWN` to `SUBMITTED`.

---

## 19. Resume

```ts
const result = await up.client.callTool({
  name: checkpoint.tool.split("__")[1],
  arguments: checkpoint.arguments,        // EXACT same object
});
```

Do not regenerate the request. Do not "improve" the arguments. Same semantic input, same `tool_call_id` in your ledger. The agent gets a normal successful tool result and has no idea anything happened.

---

## 20. Idempotency

```
purchase:  purchase:{taskId}:{requirementHash}
resume:    resume:{taskId}:{failedToolCallId}
approval:  approval:{mandateId}
adapter:   adapter:{billingOrigin}:{version}
```

`requirementHash = sha256(provider + resource + amount)`. Same shortfall detected twice from two surfaces resolves to one purchase.

Two places this saves you:

- The agent retries the original call after an `AWAITING_APPROVAL` return. Second recovery job resolves to the same `requirementHash`, joins the existing job, no second purchase.
- Browser worker reports success twice after a network blip. Mandate consumption is a conditional UPDATE; the second one returns zero rows and aborts.

"Did we buy?" must be answerable without buying again.

---

## 21. Data model

```sql
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  agent_id     TEXT,
  surface      TEXT NOT NULL,          -- 'cli' | 'web'
  status       TEXT NOT NULL,
  origin_provider TEXT,
  origin_url   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tool_calls (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES tasks(id),
  tool_name    TEXT NOT NULL,
  arguments    JSONB NOT NULL,
  args_hash    TEXT NOT NULL,
  status       TEXT NOT NULL,
  error        JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE recovery_jobs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES tasks(id),
  tool_call_id TEXT REFERENCES tool_calls(id),
  blocker_type TEXT NOT NULL,
  requirement  JSONB NOT NULL,
  req_hash     TEXT NOT NULL,
  status       TEXT NOT NULL,
  lane         TEXT,                   -- 'fast' | 'slow'
  UNIQUE (task_id, req_hash)           -- ← idempotency, enforced by the DB
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY, recovery_job_id TEXT REFERENCES recovery_jobs(id),
  product_id TEXT, quantity INT, units_granted NUMERIC,
  price NUMERIC, currency TEXT, billing_type TEXT, auto_renew BOOL, reason TEXT
);

CREATE TABLE mandates (
  id TEXT PRIMARY KEY, quote_id TEXT REFERENCES quotes(id), task_id TEXT,
  billing_origin TEXT NOT NULL, max_amount NUMERIC NOT NULL, currency TEXT,
  nonce TEXT NOT NULL, signature TEXT NOT NULL,
  status TEXT NOT NULL,                -- pending | approved | consumed | rejected | expired
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY, mandate_id TEXT REFERENCES mandates(id),
  provider TEXT, amount NUMERIC, currency TEXT,
  transaction_id TEXT, lane TEXT,
  steel_session_id TEXT, trace_export_id TEXT, receipt_file_ids TEXT[],
  status TEXT NOT NULL,                -- submitted | unknown | verified | failed
  verified_at TIMESTAMPTZ
);

CREATE TABLE spend_state (
  scope TEXT PRIMARY KEY,              -- 'task:{id}' | 'day:{user}:{yyyy-mm-dd}'
  amount NUMERIC NOT NULL DEFAULT 0,
  attempts INT NOT NULL DEFAULT 0
);

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB,
  at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON events (task_id, id);
```

---

## 22. Event stream

Every UI is a projection of this.

```
TASK_CREATED
TOOL_CALL_STARTED           tool=higgsfield__generate_image
TOOL_CALL_FAILED            type=INSUFFICIENT_CREDITS
RECOVERY_CREATED
CHECKPOINT_FROZEN           origin=https://higgsfield.ai
ENTITLEMENT_CHECK_STARTED
ENTITLEMENT_CHECKED         openrouter=owned  higgsfield=0
QUOTE_CREATED               $20 / 5000 credits / one_time
POLICY_PASSED               remaining task=$100 day=$250
MANDATE_SIGNED
APPROVAL_REQUESTED          url=https://aisle.dev/r/abc
APPROVAL_GRANTED
PURCHASE_STARTED            lane=browser
STEEL_SESSION_CREATED       viewer=...
PROFILE_RESTORED            profileId=... age=3d
RESOLVER_CALLED             profile=PICKER model=anthropic/claude-sonnet-4.6 (2/5)
CHECKOUT_STAGED
MANDATE_COMPARISON_PASSED   staged=$20.00 cap=$25.00
PURCHASE_SUBMITTED
PURCHASE_COMPLETED          txn=...
RECEIPT_CAPTURED            files=2
ENTITLEMENT_VERIFIED        0 → 5000
TRACE_EXPORTED
TOOL_CALL_RETRIED
TOOL_CALL_SUCCEEDED
TASK_RESUMED
ADAPTER_RECORDED            higgsfield v1
```

Refusal variants:

```
POLICY_REFUSED  reason=ORIGIN_VIOLATION  attempted=evil.example  authorized=higgsfield.ai
POLICY_REFUSED  reason=PER_TASK_CEILING  cumulative=$50 requested=$80 remaining=$50
TAKEOVER_REQUESTED  reason=3DS_CHALLENGE
```

---

## 23. Build order

**H+0 → H+3 — close the loop with zero browsers.**

```
MCP proxy → mock vendor tool → hardcoded 402 → recovery → FAKE purchase
→ entitlement update → replay → agent continues
```

```ts
async function purchaseCredits() {
  return { success: true, creditsAdded: 5000, amount: 20 };
}
```

If this loop doesn't close in three hours, the demo has no ending. **No Steel yet. No Playwright yet.**

**H+3 → H+5 — approval and state.** Recovery job, quote, mandate, ceilings, the `/r/{id}` page. `402 → approval → fake purchase → resume` end to end.

**H+5 → H+7 — make it look real.** Timeline, approval card, resume animation. **Record a clean run here.** That recording is your wifi insurance and you will not get a calmer moment to make it.

**H+7 → H+12 — Steel enters.** Mock vendor website first, never a real one. Session create, CDP connect, navigate, screenshot. Get the viewer embedded in `/r/{id}`.

**H+12 → H+16 — the adapter.** `discoverOffer` / `stagePurchase` / `verifyPurchase` against your mock site. Tier 2 replay working.

**H+16 → H+20 — security, and it is the demo.** Origin lock, three ceilings, single-use mandate, mandate-vs-checkout comparison. These matter more to the story than browser sophistication.

**H+20 → H+24 — profiles and promotion.** `persistProfile`, release-then-READY, the warm second run. Tier 3 cold resolution if time permits.

**H+24 — FEATURE FREEZE.** Polish, script, re-record.

**H+24+ — at most one real vendor** on each lane. Everything else stays mocked. Never let a real service decide whether your demo works.

---

## 24. Demo script — 3 minutes

**0:00 — Terminal only.** Hermes takes "generate three hero images." Image 1 lands. Image 2 returns 402. Hold the silence for two full seconds. That's the status quo, and it's the whole problem.

**0:20 — The terminal doesn't die.** A progress line appears and a URL prints. Pick up the phone.

**0:35 — Split to three panes.** Terminal, timeline, Steel viewer. Timeline runs the checkpoint, the entitlement read — vendor A already owned, skipped; vendor B at zero — and the quote.

> Say: *"It doesn't ask what it can buy. It asks what's the minimum to finish this task."*

**1:00 — Both lanes.** Fast lane on vendor A completes in about a second. Slow lane on vendor B opens Steel. Viewer shows the pricing page loading through the proxy, already logged in from the stored profile.

**1:30 — Approval.** The card on screen and on the phone: $20, 5,000 credits, one-time, no auto-renew, what it unblocks, the origin, all three remaining ceilings. One tap.

**1:45 — Checkout.** Steel fills the form.

> Say: *"The card is typed by Steel. It never enters our process, never enters a tool result, never enters a model prompt."*
> (Only say this if §15.7 verified true.)

Then the mandate-vs-checkout comparison frame. Then confirmation, receipt captured, balance re-read.

**2:10 — The payoff.** Terminal resumes mid-task. Images 2 and 3 land.

> Say: *"No restart. No re-prompt. Same conversation, same context."*

Give this room. It's the product.

**2:30 — The two refusals.** Fast.

1. Poisoned tool result pointing at another domain → `ORIGIN_VIOLATION`.
2. A second purchase over the task ceiling → blocked, with cumulative spend on screen.

**2:50 — Close.**

> *"The interesting part isn't the buying. It's the two places it says no."*

**Backups, in order:** the recorded run; the warm second run (30s vs 60s) if they want to see profiles; the web widget path if they ask about non-CLI agents; HITL takeover if anyone asks about 3DS.

---

## 25. Failure catalogue — test these

| Failure | Correct behaviour |
|---|---|
| 429 with `Retry-After: 10` | Sleep and retry. **Do not buy.** |
| Balance already sufficient | `ALREADY_COVERED`, replay, no purchase |
| Profile cookies expired | Liveness probe fails → re-auth → continue |
| Captcha mid-checkout | Sidecar solves; waits tolerate 90s |
| 3DS / OTP | `TAKEOVER_REQUESTED`, hand over the session |
| Staged amount > mandate cap | Abort before submit |
| Subscription when one-time expected | Abort before submit |
| Submit succeeds, response lost | `RESULT_UNKNOWN` → verify by balance. **Never retry.** |
| Balance doesn't move after success | `PurchaseVerificationError`, purchase marked failed |
| Duplicate approval tap | Idempotent on `approval:{mandateId}` |
| Agent retries the blocked call | Joins existing job via `req_hash` |
| Mandate consumed twice | Conditional UPDATE returns zero rows, abort |
| Purchase URL from error body | Host mismatch → discarded |
| Adapter selector miss | Fall back to tier 3, re-record, version++ |
| Resolver returns out-of-range index | Reject in code before touching the page |
| Resolver model down / rate-limited | OpenRouter `models` array falls through |
| Resolver loops without converging | `RESOLUTION_EXHAUSTED` at 5 calls |
| **Aisle's own OpenRouter key 402s** | `INFRA_BLOCKED`. Fail loud. **Never open a recovery job.** |
| Session times out during approval | Explicit long timeout prevents it |
| Second run loads stale profile | Wait for `READY` after release |

---

## 26. Verify before the hackathon, not at H+0

1. **Extensions attach correctly and the `document.modelContext` polyfill runs.** This is your highest-value de-risking. Ship it as an extension, not a CDP script injection.
2. **Whether the Credentials vault can hold card fields.** Your headline safety claim depends on it. If not, use Stripe test mode and change the sentence.
3. **The session `timeout` parameter name and maximum.** Default five minutes will kill you mid-approval.
4. **Profile `READY` latency after release.** Determines whether the warm-run demo is viable back to back.
5. **Your MCP client's tool-call timeout.** Sets `SAFE_BLOCK_MS` and decides whether you need the two-phase fallback at all.
6. **Trace export format.** If it's not attachable to a record, the audit story is just a video.
7. **OpenRouter model slugs.** They move. Confirm against the live catalogue and keep a two-deep `models` fallback array.
8. **`OPENROUTER_INFRA_KEY` is funded and separate** from any key the demo treats as a purchasable vendor. Check it the morning of, not at H+0.

---

## 27. What's mocked, and say so

**Always mocked:** real cards, real vendor credentials, real balances, anything irreversible.

**Real:** Steel sessions, Playwright, the MCP proxy, the agent, approval UX, the event stream, Stripe test mode, the mock vendor site, profiles, traces, OpenRouter resolver calls.

**Recorded, not faked:** tier-3 resolver choices under `REPLAY_RESOLVER=1` (§16.7). These were produced by a real model on a real page during rehearsal. If asked, say that — it's replay, not fabrication, and the distinction is defensible.

The audience should see every mechanism and zero financial risk. Say this out loud once, early. It buys you credibility for everything that follows, and it stops the question that otherwise arrives during your payoff moment.

---

## 28. The one-sentence version

> The agent runs the task. Aisle catches payment failures. OpenRouter decides what to click and Steel executes the purchase when no API exists. A signed mandate plus a verified entitlement puts the agent back exactly where it stopped.
