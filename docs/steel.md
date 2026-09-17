# Steel in Aisle

**Every Steel surface we use, what job it does, and where it breaks.**

Companion to `aisle-pipeline.md`. That doc is the whole system; this one is the slow lane in depth.

`⚠ VERIFY` = confirm against live docs/SDK before building on it. Some of these are marked because Steel's own documentation is internally inconsistent, not because I'm unsure it exists.

---

## 1. The boundary

**Steel owns the browser. It does not own any decision.**

Steel opens a real Chrome in the cloud, gives it an identity that survives between runs, routes it through a residential IP, solves captchas, lets a human take the wheel, and records everything that happened. What to buy, whether to buy, and whether the purchase actually landed are all Aisle's, and none of them are delegated to a page.

If you can draw a line from "something Steel returned" to "money moved" without passing through the mandate comparison, you've built it wrong.

---

## 2. Capability map

| Steel surface | Job in Aisle | Section |
|---|---|---|
| Sessions API | The purchase worker's browser | §3, §4 |
| `timeout` / `inactivityTimeout` | Surviving the human approval wait | §3 |
| CDP connect | Playwright drives; also the web-path 402 trigger | §5 |
| Profiles API | "Remembering" — logged-in vendor identity across runs | §6 |
| Auth context | Lighter, isolated alternative to profiles | §7 |
| Credentials API | Re-login without credentials touching our process | §8 |
| Proxies / dedicated IP | Network identity pinned to browser identity | §9 |
| Stealth | Not getting flagged on a checkout page | §10 |
| Captchas | Clearing challenges mid-purchase | §11 |
| Extensions API | WebMCP polyfill + in-page approval widget | §12 |
| Browser Tools | Pricing page → markdown → quote engine | §13 |
| Files API | Receipts, invoices, license keys survive teardown | §14 |
| Agent Traces | The audit artifact attached to every purchase | §15 |
| Embed / viewer | Approval page, live demo pane, post-hoc replay | §16 |
| HITL interactive | 3DS / OTP takeover — the third refusal | §16.3 |
| Multi-region | Currency and fraud-flag correctness | §17 |
| Steel CLI + skills | Build speed | §19 |

Not used: Selenium mode, Puppeteer, Mobile Mode, Fullscreen Mode, self-hosting in production.

---

## 3. Session lifecycle — and the two timeouts that will kill your demo

Default session: desktop, headful, **5-minute timeout**, no proxy, no captcha solving.

There are two independent clocks and you need both configured deliberately.

**`timeout`** — hard cap on session lifetime, in milliseconds, default `300000`. The session is automatically released when it elapses. **It cannot be edited on a live session.** Whatever you set at create time is what you get.

**`inactivityTimeout`** — releases the session early once it stops seeing activity, where activity means any CDP command or remote input. Omitting it disables inactivity-based release, which is the default. If `inactivityTimeout >= timeout` it has no effect, because `timeout` elapses first.

### Why this is the single most dangerous thing in the doc

Aisle's flow deliberately parks a live browser at a staged checkout while a human taps approve on a phone. During that wait there are **no CDP commands**. That's not idle-and-fine, that's exactly what `inactivityTimeout` is designed to kill. And because `timeout` can't be extended on a live session, discovering the problem at 1:40 into your demo leaves you with no recovery.

Rules:

1. **Never set `inactivityTimeout` on a purchase-worker session.** Omit it. Yes, you pay for an idle browser. It's a hackathon.
2. **Set `timeout` generously at create.** 15 minutes. You cannot raise it later.
3. If you must use `inactivityTimeout` for cost reasons, run a heartbeat during the approval wait:
   ```ts
   const hb = setInterval(() => cdp.send("Runtime.evaluate", { expression: "1" }), 20_000);
   try { await waitForApproval(); } finally { clearInterval(hb); }
   ```
   A no-op CDP command counts as activity. This is a workaround, not a design — prefer rule 1.

### `⚠ VERIFY` — the parameter name is documented inconsistently

Steel's own SDK reference lists `timeout?: number` in the Node parameter table but writes `sessionTimeout: 1800000` in the adjacent example. The Python reference lists `api_timeout` in the table and `session_timeout` in the example.

An unrecognised key is silently ignored, which means you get the 5-minute default and don't find out until the session dies mid-approval. **Assert it, don't assume it:**

```ts
const session = await client.sessions.create({ timeout: 15 * 60_000 /* ...*/ });
console.log("actual timeout:", session.timeout);   // ⚠ confirm this reflects what you set
if (session.timeout < 10 * 60_000) throw new Error("Steel timeout param name is wrong");
```

Do this on day one. It's a one-line check that protects the only irreversible parameter in the system.

### Release explicitly

```ts
try {
  await runPurchase(page, mandate);
} finally {
  await browser.close();
  await client.sessions.release(session.id);
}
```

Best practice generally, mandatory for us, because profile persistence is triggered by release (§6).

---

## 4. Our three session configurations

We create three different kinds of session. They are not interchangeable.

### 4.1 Purchase worker — the slow lane

```ts
const session = await client.sessions.create({
  profileId,                    // (user_id, provider) → profileId
  persistProfile: true,         // ⚠ VERIFY exact param name
  useProxy: true,
  solveCaptcha: true,
  timeout: 15 * 60_000,         // long. cannot be raised later.
  // inactivityTimeout: OMITTED ON PURPOSE — see §3
  blockAds: true,
  dimensions: { width: 1280, height: 720 },
});
```

Headful (the default) because the viewer streams headful, and we want the audience watching this one.

**Do not use `optimizeBandwidth` here.** Blocking images and media is a fine idea for scraping and a bad idea for checkout: payment widgets, 3DS iframes, and card-brand detection all break in ways that look like your code failing. Stylesheets in particular affect page behaviour, not just appearance.

### 4.2 Read-only entitlement probe

Cheap, fast, no writes. Used to refresh the ledger before quoting.

```ts
const probe = await client.sessions.create({
  profileId,
  persistProfile: false,        // read path must not mutate the stored identity
  useProxy: true,
  timeout: 90_000,
  inactivityTimeout: 30_000,    // safe here — this session is never parked
  optimizeBandwidth: { blockImages: true, blockMedia: true, blockStylesheets: false },
});
```

Note `blockStylesheets: false` — Steel's own recipe keeps stylesheets because they can affect page behaviour.

### 4.3 The web-path session (user browsing inside Steel)

Long-lived, user-facing, carries the CDP 402 listener and the injected widget extension.

```ts
const userSession = await client.sessions.create({
  profileId: userBrowsingProfile,
  persistProfile: true,
  timeout: 60 * 60_000,
  // extensions attached — see §12
});
```

---

## 5. Connecting

```ts
const browser = await chromium.connectOverCDP(
  `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`
);
const context = browser.contexts()[0];
const page    = context.pages()[0];    // Steel hands you a page already open
```

No `newContext()` / `newPage()` ceremony — reach into `contexts()[0].pages()[0]`. Creating a fresh context here is a real bug: a new context does **not** inherit the mounted profile, so you'd throw away the logged-in state you just paid to restore.

Raw CDP for the things Playwright doesn't expose:

```ts
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");                    // §5.6 of the pipeline doc: 402 trigger
const { nodes } = await cdp.send("Accessibility.getFullAXTree");   // §17: click resolution
```

---

## 6. Profiles — the "remembering" layer

### What it stores

A snapshot of the full Chromium user data directory: cookies and localStorage for every origin visited, live login sessions, IndexedDB entries, installed extensions and their configuration, autofill, history, bookmarks, and site permissions.

### Lifecycle

1. Create a session with `persistProfile: true` and a `profileId`.
2. Profile enters `UPLOADING` state.
3. **After the session is released**, the userDataDir is persisted and the profile moves to `READY`.
4. Any future `sessions.create({ profileId })` loads that userDataDir.

### The race that breaks a back-to-back demo

The write happens on release, not during the run. Skipping release keeps the browser alive until timeout and delays the snapshot.

```ts
await client.sessions.release(session.id);
await waitForProfileReady(profileId);   // poll until READY before any second run
```

If your demo runs the same vendor twice to show cold-vs-warm, run two must wait for `READY` or it loads a stale profile and the whole point of the segment evaporates.

### Our table

```sql
CREATE TABLE vendor_profiles (
  user_id      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  profile_id   TEXT NOT NULL,
  dedicated_ip TEXT,
  last_ok_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, provider)
);
```

One profile per `(user, vendor)`. Not one per user — mixing vendors in one profile means a challenge on one site pollutes the identity you use everywhere else.

### Pin the profile to an IP

Steel's guidance: profiles preserve browser identity, dedicated IPs preserve network identity, and for account-based agents the strongest setup is one profile plus one dedicated IP per account, so sites see the same cookies, storage, and a familiar IP instead of a fresh browser from a new network every run.

Week-old cookies arriving from a new egress IP is the signature of a stolen session. Rotating the IP while reusing the profile makes remembering *worse* than starting cold.

### Liveness probe — always, before checkout

Cookies expire on their own schedule.

```ts
await page.goto(`${billingOrigin}/account`);
const live = await page.getByTestId("account-email").isVisible().catch(() => false);
if (!live) await reAuthenticate(page);     // §8
```

Run this immediately after connect. Finding out you're logged out at the card step is the worst possible place to find out.

### The security property nobody mentions

Profiles accumulate in place; they do not fork. Anyone who can call `sessions.create({ profileId })` on your workspace drives a browser logged in as that user. Treat a `profileId` like an account credential in your own threat model — it belongs in the same tier as an API key, not in logs, not in a tool result, not in a model prompt.

---

## 7. Auth context — the isolating alternative

```ts
const sessionContext = await client.sessions.context(session.id);   // plain JSON
const next = await client.sessions.create({ sessionContext });
```

A snapshot of cookies and localStorage at a point in time, keyed by origin. Plain JSON you can store, ship between machines, and diff.

| | Profiles | Auth context |
|---|---|---|
| Scope | Full userDataDir | Cookies + localStorage only |
| Mutation | Accumulates in place | Immutable snapshot you own |
| Decay | Slower | Usable today, often not next week, rarely next month |
| Residue from a failed job | Persists | None unless you re-capture |

**Use profiles for the demo.** Use auth-context when you want a refused or failed recovery job to leave zero trace — capture only on a verified outcome. Treat the blob as sensitive: it holds session tokens, and anyone with it can impersonate the logged-in user until they expire.

---

## 8. Credentials API

Stores username and password. Steel re-authenticates each session by filling the login form. Works for any site with a standard form; the login UI runs every session. **Credentials never enter our process and never enter a model prompt.**

Complementary to auth-context, not redundant with it:

- **Credentials** — stable, long-lived, tied to an account. Reach for this by default.
- **Auth context** — for flows the vault cannot drive: SSO, MFA prompts, magic links. You log in once by hand and move the resulting state forward.

Our re-auth path when the liveness probe fails is Credentials. Our fallback when a vendor uses SSO is auth-context plus a one-time manual login through the interactive viewer (§16.3).

### `⚠ VERIFY` — card fields

The Credentials API is documented for **login forms**. Whether the vault will hold and type **card fields** is a separate question, and one of our stage lines depends on it:

> *"The card is typed by Steel. It never enters our process, never enters a tool result, never enters a model prompt."*

Check this before the hackathon. If it doesn't hold card data, the fallback is Stripe test mode on the mock vendor with the card pre-saved in the profile's autofill — which is still true to the spirit (the number lives in the browser identity, not in our process) but the sentence has to change to match. **Do not say the line if the demo doesn't do the thing.**

---

## 9. Proxies

`useProxy: true` enables Steel-provided residential proxying. It operates at the network layer, below Chrome, which has a useful security consequence: a compromised page script cannot route around it, and Playwright can neither see nor change the egress.

For the purchase worker, prefer a dedicated IP pinned to the profile (§6). For the read-only probe, rotating is fine.

---

## 10. Stealth

Chrome launch flags and patched internals, applied before your socket exists. Nothing to configure at runtime and nothing to do.

The only way to undermine it is to fight it: don't set a custom `userAgent` that contradicts the fingerprint Steel established, and don't vary the fingerprint between runs on the same profile. Both make you *more* detectable, not less.

---

## 11. Captchas

`solveCaptcha: true`, plus a dedicated Captchas API for monitoring. The solver is a sidecar watching the session and resolves asynchronously.

**This changes every timeout in your checkout path.** A captcha pause is tens of seconds inside steps that otherwise complete in under a second. Playwright's 30-second default will fail mid-solve and you'll retry into a half-submitted checkout — the single worst state in this system.

```ts
page.setDefaultTimeout(90_000);        // whole page, checkout path
await page.getByRole("button", { name: /complete purchase/i }).click({ timeout: 90_000 });
```

Steel's own guidance is 60 seconds for complex captchas. We use 90 because ours sits inside a payment flow where a retry is not free.

---

## 12. Extensions API

**This is what retires the `document.modelContext` risk.**

Extensions are uploaded once as `.zip` or `.crx` (or pulled from the Chrome Web Store), stored globally against your organization, and attached to any session. They need a `manifest.json` with name, version, and permissions.

```
extension/
├── manifest.json
├── polyfill.js      # spec-shaped document.modelContext shim
├── widget.js        # in-page approval card (web path)
└── content.js       # registers both at document_start
```

```ts
await client.extensions.upload({ file: fs.readFileSync("extension/aisle.zip") });
// attach on session create — ⚠ VERIFY the attach parameter name
```

Why an extension rather than `Page.addScriptToEvaluateOnNewDocument`:

- Survives redirects and cross-origin navigations, which a CDP-injected script does not reliably do across a multi-step checkout.
- One upload per organization, not one injection per session.
- Same mechanism serves both the purchase worker (polyfill) and the user-facing web session (widget).
- Profiles capture installed extensions and their configuration, so a restored profile arrives with it already present.

Extensions are in beta. **Verify it attaches and the polyfill actually runs before the hackathon, not at H+0.** This is the single highest-value pre-flight check in the project.

---

## 13. Browser Tools

APIs to convert pages to markdown, readability, screenshots, or PDFs.

**Feed the quote engine markdown, not DOM.**

```ts
const md = await browserTools.toMarkdown(page.url());     // ⚠ VERIFY method shape
const packages = await resolver.extractPackages(md, requirement);
```

Far more robust across vendor redesigns than selectors, and much cheaper than sending screenshots to a vision model. This is the split from the pipeline doc: **markdown for reading what the packages are, the AX tree for deciding what to click.** Different jobs, different tools, don't merge them.

On the confirmation page, take the PDF or screenshot as a receipt artifact and attach it to the purchase record.

---

## 14. Files API

Two systems: **session files** for working with files inside an active session, and **global files** for persistent storage across the organization. Files acquired during browsing can be downloaded, and files from completed sessions are preserved for later access.

This is how we deliver on "the purchase doesn't end at checkout."

```ts
const download = await page.waitForEvent("download");
const sessionFile = await client.sessions.files.upload(session.id, {
  file: await download.path(),
});
await db.purchases.attachFile(purchaseId, sessionFile.id);
```

Capture on the confirmation page: invoice PDF, license key file, any vendor-triggered download. Without this, the license key dies with the session and the agent resumes into a task it still can't complete.

Global files also give you the upload direction, if a vendor ever needs a document at checkout.

---

## 15. Agent Traces

Has its own API with a timeline and exports — not just a viewer pane.

```ts
const trace = await client.traces.export(session.id);    // ⚠ VERIFY method shape
await db.purchases.update(purchaseId, { trace_export_id: trace.id });
```

**This converts the safety story from a claim into a file.** "Here is exactly what it clicked, in order, with timings, attached to this purchase record" is a different class of answer than "here's a video." Every row in `purchases` should carry a trace id.

Export on the success path *and* on the refusal path. A refused origin-violation with an attached trace is the most persuasive artifact you will produce all weekend.

---

## 16. Embed, viewer, and human-in-the-loop

### 16.1 Two embed types

- **Live** — streams an active session in real time over WebRTC, headful by default.
- **Replay** — plays back a recorded past session.

`session.sessionViewerUrl` comes back on the create response. Live embed powers the approval page and the demo pane; replay powers the post-hoc audit view.

### 16.2 The interactive flag is a security boundary

Two query parameters turn a viewer into a takeover surface:

- `interactive=true` — users can click, scroll, and fill forms
- `showControls=true` — shows the nav bar with URL entry and forward/back

With both enabled, a user can fill forms, enter arbitrary URLs, and navigate freely. And the docs are explicit: **any actions taken in an interactive session affect the actual browser session and state.**

That browser is logged into the user's vendor account via a restored profile.

**Therefore: `interactive=false` by default on the approval page.** The user is there to approve a transaction, not to drive a browser that holds their credentials. Flip it to `true` only for an explicit, scoped takeover, and flip it back when the takeover resolves.

```ts
const viewerUrl = takeoverActive
  ? `${session.debugUrl}?interactive=true&showControls=true`
  : `${session.debugUrl}?interactive=false&showControls=false`;
```

Recommended minimum iframe height is 600px, and it should be visually obvious to the user when they can interact.

### 16.3 The takeover beat

When checkout throws 3DS, an OTP, or anything the automation cannot legitimately clear:

```ts
if (await detectChallenge(page)) {
  await events.emit(taskId, "TAKEOVER_REQUESTED", { reason: "3DS_CHALLENGE" });
  await grantInteractive(session.id);           // flip the flag
  await waitForChallengeCleared(page, { timeout: 5 * 60_000 });
  await revokeInteractive(session.id);          // flip it back
  await events.emit(taskId, "TAKEOVER_RESOLVED");
}
```

This is the third place Aisle says no — the most honest one, and the answer to the inevitable "what about bank verification" question. We don't fail, and we don't fake it. We hand over the wheel in the same session and resume.

It's also the manual-login path for SSO vendors the Credentials vault can't drive.

---

## 17. Multi-region

Set the session region to match the account's billing region. This matters more than it looks for a purchasing product: a mismatch is both a currency problem (you quote $20 and get charged €20) and a fraud-flag problem (a US-billed card checking out from a European IP gets declined).

`⚠ VERIFY` the parameter name and available regions.

---

## 18. Deliberately not using

| Surface | Why not |
|---|---|
| Selenium mode | We're on Playwright |
| Puppeteer | Same |
| Mobile Mode | No vendor flow needs it |
| Fullscreen Mode | Nice for the demo pane; not load-bearing. Add at H+20 if there's time. |
| Self-hosting (Docker/Railway/Render) | Not in the demo path |

**Steel Local** is worth knowing about for one reason: developing against it avoids burning cloud session credits during the 12 hours you'll spend iterating on selectors. Check the Steel Local vs Steel Cloud doc for feature gaps before you rely on it — stealth and proxies in particular may not be equivalent.

---

## 19. Tooling

`steel forge <recipe>` scaffolds starter projects locally via the Steel CLI. Start from the Playwright Node recipe rather than writing the connect boilerplate.

Steel publishes skills — `steel-developer`, `steel-reliability`, `steel-session-debugging`, `steel-skill-creator`. Install them into Claude Code. Five minutes, and `steel-session-debugging` in particular will pay for itself the first time a session dies for a reason you can't see.

---

## 20. The whole slow lane, annotated

```ts
export async function executePurchase(mandate: PurchaseMandate): Promise<PurchaseResult> {
  verifyMandateSignature(mandate);                       // worker is a separate process
  const consumed = await consumeMandateAtomically(mandate.mandateId);
  if (!consumed) throw new Error("MANDATE_ALREADY_USED");

  const prof = await db.vendorProfiles.get(mandate.userId, mandate.provider);

  const session = await client.sessions.create({
    profileId: prof?.profile_id,
    persistProfile: true,
    useProxy: true,
    solveCaptcha: true,
    timeout: 15 * 60_000,        // §3 — cannot be raised later
    // inactivityTimeout omitted — we park this session during approval
    blockAds: true,
    dimensions: { width: 1280, height: 720 },
  });
  assertTimeoutApplied(session);                          // §3 verify guard
  await events.emit(taskId, "STEEL_SESSION_CREATED", { viewer: session.sessionViewerUrl });

  const browser = await chromium.connectOverCDP(
    `wss://connect.steel.dev?apiKey=${STEEL_KEY}&sessionId=${session.id}`
  );
  const context = browser.contexts()[0];
  const page    = context.pages()[0];                     // §5 — do NOT newContext()
  page.setDefaultTimeout(90_000);                         // §11 — captcha tolerance

  let purchase: PurchaseResult;
  try {
    // 1. identity check before anything that matters
    await page.goto(`${mandate.billingOrigin}/account`);
    if (!(await isLoggedIn(page))) await reAuthenticate(page);   // §8
    await events.emit(taskId, "PROFILE_RESTORED", { profileId: prof?.profile_id });

    // 2. read the offer — markdown, not DOM
    await page.goto(`${mandate.billingOrigin}/pricing`);
    const balanceBefore = await readBalance(page);
    const offers = await discoverOffers(page);            // §13 + tier 1/2/3 ladder

    // 3. stage, never submit yet
    const staged = await stagePurchase(page, offers, mandate);
    await events.emit(taskId, "CHECKOUT_STAGED", staged);

    // 4. THE GATE — compare staged checkout to the signed mandate
    assertMatchesMandate(staged, mandate);                // aborts before any spend
    await events.emit(taskId, "MANDATE_COMPARISON_PASSED", {
      staged: staged.amount, cap: mandate.maximumAmount,
    });

    // 5. deterministic submit. never the model path.
    await submit(page);
    await events.emit(taskId, "PURCHASE_SUBMITTED");

    // 6. challenges → human, not a workaround
    if (await detectChallenge(page)) await runTakeover(session, page);   // §16.3

    // 7. artifacts before teardown
    const files = await captureReceipts(page, session);   // §14
    await events.emit(taskId, "RECEIPT_CAPTURED", { files: files.length });

    // 8. entitlement, by reading the balance — not the receipt
    const balanceAfter = await readBalance(page);
    if (balanceAfter < balanceBefore + mandate.unitsGranted) {
      throw new PurchaseVerificationError();
    }

    purchase = { status: "verified", balanceBefore, balanceAfter, files };
  } catch (e) {
    if (isAfterSubmit(e)) {
      purchase = { status: "unknown" };                   // §21 — DO NOT RETRY
    } else {
      purchase = { status: "failed", error: e };
    }
  } finally {
    const trace = await client.traces.export(session.id).catch(() => null);   // §15
    await browser.close();
    await client.sessions.release(session.id);            // §6 — triggers profile write
  }

  if (purchase.status === "unknown") {
    purchase = await resolveByObservation(mandate);       // re-read balance, not re-buy
  }
  if (purchase.status === "verified") {
    await waitForProfileReady(prof.profile_id);           // §6 — before any next run
    await registry.recordAdapter(mandate.billingOrigin);  // tier 3 → tier 2 promotion
  }
  return purchase;
}
```

---

## 21. Steel-specific failure modes

| Failure | Cause | Correct behaviour |
|---|---|---|
| Session dies at 5 min | `timeout` param name wrong, silently ignored | Assert `session.timeout` at create (§3) |
| Session dies during approval | `inactivityTimeout` set | Omit it, or heartbeat CDP |
| Logged out at the card step | Profile cookies expired | Liveness probe *before* checkout |
| Second run has stale state | Read before profile hit `READY` | Poll for `READY` after release |
| Profile never saved | Session not released | `release()` in `finally` |
| Payment widget won't render | `optimizeBandwidth` blocking media/CSS | Don't optimise the checkout session |
| Restored session challenged | IP rotated while profile reused | Pin dedicated IP to profile |
| Timeout mid-captcha | 30s Playwright default | 90s on the checkout path |
| Profile state polluted | One profile shared across vendors | One profile per `(user, vendor)` |
| Lost login state after connect | Called `newContext()` | Use `contexts()[0].pages()[0]` |
| Submit succeeds, response lost | Network blip after submit | `RESULT_UNKNOWN` → verify by balance. **Never retry.** |
| User navigated the browser from the approval page | `interactive=true` left on | Default it to false (§16.2) |

---

## 22. Pre-hackathon checklist

Run these against a real Steel account before the clock starts. Each one is a thing that costs minutes now and hours later.

- [ ] `sessions.create({ timeout })` — confirm the returned session reflects your value, not 300000. Resolve the `timeout` / `sessionTimeout` / `api_timeout` naming inconsistency.
- [ ] Upload the Aisle extension and confirm `document.modelContext` exists on a loaded page inside a Steel session.
- [ ] Create with `persistProfile` + `profileId`, release, poll to `READY`, re-create, confirm you're still logged in. **Time the READY latency** — it sets whether the back-to-back demo works.
- [ ] Confirm whether Credentials holds card fields. Decide the stage line based on the answer.
- [ ] `traces.export()` — confirm it returns something you can store an id for.
- [ ] Embed the viewer with `interactive=false` and confirm the user genuinely cannot interact.
- [ ] Flip to `interactive=true` and confirm takeover works, then flip back mid-session.
- [ ] `sessions.files.upload` on a real download from the mock vendor.
- [ ] Browser Tools markdown conversion on your mock pricing page.
- [ ] Multi-region parameter name and available regions.
- [ ] Install `steel-session-debugging` in Claude Code.

---

## 23. One line

> Steel gives the purchase a real browser with a real, remembered identity — and gives us a recording of everything it did. Every decision about whether money moves stays in Aisle.
