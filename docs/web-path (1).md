# Aisle — The Web Path

**Option B: the user browses inside a Steel session. Aisle catches the 402 on the wire.**

Third companion doc. `aisle-pipeline.md` is the system, `steel.md` is the browser layer, this is the browsing product.

---

## 1. What the product actually is now

A web app that is mostly a full-screen Steel viewer. The user browses inside it — real sites, real logins, real work. When something they're using hits a billing wall, Aisle notices before they do, quotes, asks once, buys, and the page they were on keeps working.

> **Aisle is a browser that doesn't stop at paywalls.**

That's a sharper pitch than the CLI version and it demos to a non-technical judge in ten seconds. Keep the CLI path — it proves "works with any agent" — but this is the headline.

---

## 2. The two decisions this forces

### 2.1 The approval card must live OUTSIDE the viewer

In `steel.md` §16.2 the rule was: keep `interactive=false` because an interactive viewer is a privilege escalation surface. **That rule inverts here.** The user cannot browse without `interactive=true`. That's fine — they own the accounts in that session.

But it creates a new problem. If the approval card is rendered *inside* the browsed page, any site can draw a convincing fake one and harvest a tap. This is exactly why real browsers separate chrome from content.

**Therefore:**

```
┌─────────────────────────────────────────────┐
│  AISLE CHROME  (your React app — trusted)   │
│  ┌───────────────────────────────────────┐  │
│  │  Steel viewer iframe (interactive)    │  │
│  │  ← content. Never trusted. Never      │  │
│  │    renders an approval card.          │  │
│  └───────────────────────────────────────┘  │
│  [ approval card renders HERE, in chrome ]  │
└─────────────────────────────────────────────┘
```

The in-page widget from the extension plan is now **only** for non-Aisle surfaces. Inside your own app, the card is a React component in your own DOM, outside the iframe. Say this on stage — it's the kind of detail that reads as "these people have thought about it."

### 2.2 Buy in a second session, not the browsing session

When the 402 fires, you have two options.

**Same session, new tab.** Cookies already there, user watches in place, no handoff. But the user retains interactive control of a browser that is mid-checkout, and your mandate scoping means nothing if they can click around it.

**Separate worker session.** Isolated, non-interactive, mandate-scoped, leaves no residue. The problem is getting the live logged-in state across — the profile only persists on release, and you are not releasing the user's browsing session.

**The primitive that solves it:** `client.sessions.context(sessionId)` captures cookies and localStorage from a **live** session. You don't need to release anything.

```ts
const ctx    = await client.sessions.context(browsingSession.id);   // live capture
const worker = await client.sessions.create({
  sessionContext: ctx,
  useProxy: true,
  solveCaptcha: true,
  timeout: 15 * 60_000,
  // no inactivityTimeout — this session gets parked during approval
});
```

**Do this.** The worker is non-interactive, the mandate actually constrains it, the user's browsing session is untouched, and nothing accumulates on failure or refusal.

Fallback if you're short on time at H+20: same-session new tab, and flip the browsing viewer to `interactive=false` for the duration. Note it as a known limitation rather than pretending it's a design.

### 2.3 Freeze the browsing viewer during recovery

```ts
setViewerInteractive(false);        // dim it, show "paused — action needed"
await runRecovery();
setViewerInteractive(true);
```

Two reasons. State divergence if they keep browsing, and it's a strong visual beat: the browser visibly freezes, the card slides in, one tap, it unfreezes and the page works.

---

## 3. Detection

### 3.1 Attach to every page, not just the first

The naive version listens on `pages()[0]` and misses everything the user opens in a new tab. Which is most things.

```ts
async function attachDetector(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.responseReceived", (e) => onResponse(cdp, e));
}

// existing pages
for (const p of context.pages()) await attachDetector(p);
// every future page — tabs, popups, target=_blank
context.on("page", attachDetector);
```

Out-of-process iframes are separate targets and won't be covered by the parent page's Network domain. For the demo this is fine (checkout flows that matter are top-level). Note it as a gap rather than discovering it live.

### 3.2 Get the body before it's evicted

Status alone can't distinguish `insufficient_credits` from `rate_limited`, and the body is where that lives. `Network.getResponseBody` races against buffer eviction, so fetch immediately and handle the failure.

```ts
async function onResponse(cdp: CDPSession, e: Protocol.Network.ResponseReceivedEvent) {
  const { status, url } = e.response;
  if (![402, 403, 429].includes(status)) return;

  // Rate limit, not a billing wall. Buying credits would not fix it.
  const retryAfter = Number(headerOf(e.response.headers, "retry-after"));
  if (status === 429 && retryAfter && retryAfter < 60) return;

  // ENROLLMENT GATE — see §4. This is the whole security story for this path.
  const enrolled = await db.enrollments.byOrigin(userId, new URL(url).origin);
  if (!enrolled) {
    return ui.suggestEnrollment(new URL(url).origin);   // notification. NOT a quote.
  }

  let body = "";
  try {
    ({ body } = await cdp.send("Network.getResponseBody", { requestId: e.requestId }));
  } catch {
    // body already evicted — classify on status + enrollment metadata alone,
    // and mark the blocker low-confidence so the quote asks for more explicit confirmation
  }

  const blocker = classifyHttp(status, body, enrolled.provider);
  if (blocker.type === "UNKNOWN") return;

  await recovery.create({
    taskId: browsingSession.taskId,
    blocker,
    origin: enrolled.canonicalOrigin,     // ← FROM THE ENROLLMENT ROW. Never from `url`.
    billingOrigin: enrolled.billingOrigin,
  });
}
```

Note the origin passed into `recovery.create` comes from the enrollment record, not from the URL that triggered. Same discipline as `upstreams.json` in the MCP path: the trigger tells you *which* enrollment matched, it does not get to define where money goes.

### 3.3 Don't use the Fetch domain

`Fetch.enable` with request interception is more reliable for bodies but pauses every request until you resume it. One bug and the user's browser hangs. Not worth it for a demo. `Network` + graceful body failure is the right trade.

### 3.4 Don't scrape the DOM

No "upgrade your plan" text matching. It's fuzzy, it's locale-dependent, and it's forgeable by any page. The wire signal is the same shape as the MCP signal, which is the entire point — one classifier, two transports.

---

## 4. Enrollment — the security story for this path

The MCP path gets origin lock free, because origins come from a config file nothing at runtime can write to. **The web path has no config file.** The user browses anywhere; any site can return a 402 with a body saying whatever it likes.

So the user explicitly connects a vendor first.

```sql
CREATE TABLE enrollments (
  user_id          TEXT NOT NULL,
  provider         TEXT NOT NULL,
  canonical_origin TEXT NOT NULL,     -- where the API 402s from
  billing_origin   TEXT NOT NULL,     -- where purchases are made. NEVER inferred.
  profile_id       TEXT,              -- Steel profile for this vendor
  enrolled_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, canonical_origin)
);
```

| 402 from | Behaviour |
|---|---|
| Enrolled origin | Full pipeline: quote → mandate → tap → buy → resume |
| Unenrolled origin | Toast: *"Looks like Foo wants payment. Connect Foo to let Aisle handle this?"* No quote, no mandate, no purchase. |

`billing_origin` is set at enrollment time by the user or by your vendor catalogue. **Never derived from the 402 body**, never from a link on the page. That's the origin lock, relocated from a file to a row.

A judge will go looking for exactly this hole. Volunteer it before they ask.

---

## 5. Session configuration for browsing

```ts
const browsingSession = await client.sessions.create({
  profileId: userBrowsingProfile,      // one per user, persists their logins
  persistProfile: true,
  useProxy: true,
  solveCaptcha: true,
  timeout: 60 * 60_000,                // an hour. CANNOT be raised later.
  // inactivityTimeout: see below
  dimensions: { width: 1440, height: 900 },
});
```

**The inactivity trap applies here too, in a subtler form.** Remote input from the viewer counts as activity, so ordinary browsing keeps it alive. But during the approval wait the user is interacting with your React card *outside* the iframe — zero remote input to Steel. If `inactivityTimeout` is set, the browsing session can die while they're deciding.

Omit it, or heartbeat during recovery:

```ts
const hb = setInterval(() => cdp.send("Runtime.evaluate", { expression: "1" }), 20_000);
try { await waitForApproval(); } finally { clearInterval(hb); }
```

And run the `assertTimeoutApplied()` guard — the param-name inconsistency from `steel.md` §3 costs you an hour-long session silently becoming a five-minute one.

---

## 6. Layout

```
┌──────────────────────────────────────────────────────────┐
│ Aisle    [enrolled: OpenRouter ● Higgsfield ●]   ⚙       │  ← chrome
├───────────────────────────────────────┬──────────────────┤
│                                       │  TIMELINE        │
│   Steel viewer                        │  402 detected    │
│   interactive=true                    │  balance $0.00   │
│   showControls=true                   │  quote $10       │
│   (dims + locks during recovery)      │  awaiting tap    │
│                                       │                  │
│                                       ├──────────────────┤
│                                       │  APPROVAL CARD   │
│                                       │  ← IN CHROME.    │
│                                       │  never in iframe │
└───────────────────────────────────────┴──────────────────┘
        ↑ during purchase, this pane swaps to the WORKER session viewer
```

Minimum iframe height 600px. Make it visually obvious when the viewer is live versus frozen — a dim overlay plus a one-line status is enough.

The pane swap during purchase is the best free visual in the whole demo: the user's browser freezes, and the same real estate fills with a second browser doing the checkout.

---

## 7. The real 402

Don't fake this one.

**Primary — OpenRouter with a zero balance.** A playground page in the Steel session calling `https://openrouter.ai/api/v1/chat/completions` with a drained key. Real vendor, real 402, real structured body, a name the audience knows.

**This must be a different account from `OPENROUTER_INFRA_KEY`.** Same provider, different key, different `account_id` in the ledger. The self-reference trap from `aisle-pipeline.md` §16.5 stops being theoretical the moment you do this — if you drain the wrong key, your resolver dies and Aisle cannot recover itself.

**Backup — your mock vendor site.** Because you can make it 402 on cue at 1:20 into the demo, and OpenRouter cannot be asked to cooperate on a schedule.

Wire both. Demo whichever is behaving that morning.

---

## 8. Build order — slots into the main checklist

Everything here depends on Phases 1–6 already being done. The classifier, quote engine, policy gate, mandate, and approval flow are shared; only the trigger and the surface are new.

**H+7 → H+9 — browsing shell**
- [ ] Full-screen viewer, `interactive=true&showControls=true`
- [ ] `assertTimeoutApplied`, no `inactivityTimeout`
- [ ] Chrome/content split: card renders outside the iframe

**H+9 → H+11 — detection**
- [ ] `Network.enable` per page + `context.on("page")` for new tabs
- [ ] `getResponseBody` with graceful eviction failure
- [ ] `Retry-After < 60` guard
- [ ] Reuse `classifyHttp` — do not fork the classifier

**H+11 → H+12 — enrollment**
- [ ] `enrollments` table, one connect button
- [ ] Unenrolled origin → toast only, verified by test

**H+12 → H+14 — worker isolation**
- [ ] `sessions.context()` live capture → worker `sessions.create`
- [ ] Freeze/unfreeze the browsing viewer
- [ ] Pane swap to the worker viewer during purchase

**H+14 → H+15 — the real 402**
- [ ] Drained OpenRouter key on a separate account
- [ ] Playground page inside the session
- [ ] Log the real body shape, add a vendor rule for it

---

## 9. Failure modes specific to this path

| Failure | Correct behaviour |
|---|---|
| 402 in a new tab, missed | `context.on("page")` attaches the detector |
| Body evicted before read | Classify on status + enrollment, mark low-confidence |
| 402 from an unenrolled origin | Toast. No quote, ever. |
| 429 with `Retry-After: 8` | Ignore. Rate limit, not a wall. |
| User keeps browsing mid-purchase | Viewer frozen for the duration |
| Browsing session dies during approval | `inactivityTimeout` omitted + heartbeat |
| Site draws a fake approval card | Card only ever renders in chrome, never in the iframe |
| Purchase origin taken from the 402 URL | Origin comes from the enrollment row |
| Worker session inherits stale cookies | `sessions.context()` captures live, not from the last release |
| Drained the infra OpenRouter key | Separate account. Check both balances demo morning. |

---

## 10. Demo, revised

**0:00** — A browser. The user is in a playground calling a model. It works.

**0:20** — Next call returns 402. **The page stalls. The browser dims.** No error dialog, no dead end.

**0:30** — Card slides into the chrome beside the frozen viewer. Balance $0.00. Minimum top-up to finish. Origin. Ceilings.

**0:50** — One tap. The viewer pane swaps to a second browser, and the audience watches the top-up happen.

**1:20** — Pane swaps back, viewer unfreezes, the original call completes. Same page, same session, same context.

**1:40** — Refusals: a 402 from an unenrolled origin produces a suggestion, not a purchase. A poisoned body pointing elsewhere gets blocked on origin.

**2:10** — Cut to the terminal. Same engine, Claude Code, MCP instead of CDP. *"It's not a browser feature. It's a layer."*

**2:40** — Close on the two refusals line.

---

## 11. One line

> The user browses in a real cloud browser. Aisle watches the wire, catches the payment wall before the user does, buys the minimum in an isolated session they can watch, and hands the page back still working.
