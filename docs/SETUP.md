# Getting onto Steel — setup order

Four blockers, in the order they actually bite.

## 1. Steel cannot reach localhost

Only **one** thing needs a public URL: the mock vendor website. The gateway,
API, and worker all run on your laptop and reach Steel outbound over wss.
The Steel browser reaches *in* to the vendor site, so that's the one that moves.

**Dev — cloudflared quick tunnel** (no account, 30 seconds):

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8080
# -> https://random-words-1234.trycloudflare.com
export PUBLIC_MOCK_VENDOR_URL=https://random-words-1234.trycloudflare.com
```

**Demo day — deploy it.** Quick-tunnel URLs change on every restart, and a URL
change silently breaks your origin lock. Railway or Render, five minutes, stable
hostname.

**When the URL changes you MUST update `apps/gateway/upstreams.json`:**

```jsonc
"mockvendor": {
  "url": "https://your-vendor.up.railway.app/mcp",
  "canonicalOrigin": "https://your-vendor.up.railway.app",
  "billingOrigin":   "https://your-vendor.up.railway.app"
}
```

Forget this and the policy gate refuses with `ORIGIN_VIOLATION` — which is the
system working correctly, and will waste twenty minutes if you don't expect it.

**Second tunnel, only if you want the phone tap:** the watch/approval page at
`localhost:8787` needs to be reachable from your phone. Start the gateway with
`AISLE_TUNNEL=1` (Cloudflare quick tunnel, needs `cloudflared`) or point
`AISLE_PUBLIC_URL` at your own tunnel, and the printed `▶ Watch live` link opens
there. Or demo the approval on the laptop.

## 2. The Steel browser isn't logged in

One manual login per vendor, then the profile carries it:

```bash
pnpm tsx scripts/steel-bootstrap-profile.ts mockvendor https://your-vendor.app/login
```

It opens an interactive viewer, you log in by hand, it releases the session and
waits for the profile to hit READY. Store the `profileId` in `vendor_profiles`.

This is also the SSO/MFA path — anything the Credentials vault can't drive, you
do once by hand here.

Check it still works on demo morning:

```bash
pnpm tsx scripts/steel-verify-profile.ts mockvendor-demo https://your-vendor.app/account
```

## 3. Plan limits

`useProxy` and `solveCaptcha` need paid balance. The pre-flight script tests
both and tells you if they're refused.

```bash
pnpm tsx scripts/steel-preflight.ts
```

Run this **first**. It resolves every ⚠ VERIFY marker in `steel.md` — the
timeout param name, profile round trip and READY latency, live auth-context
capture, extension attach and the `document.modelContext` polyfill, trace
export, and proxy/captcha availability.

## 4. Real money — don't, yet

Your own docs say mock vendor first, at most one real vendor after feature
freeze. Hold that line.

**If you do one real vendor, don't make it OpenAI.** Stripe-hosted checkout,
3DS very likely, account-security challenges on a fresh browser fingerprint,
and a real charge on a real card. It is the hardest possible first target.

**OpenRouter is the right choice.** $5 top-ups, a simple flow, and it's already
the demo vendor in your architecture. Guardrails if you go there:

- A **virtual card with a $10 hard limit**, not your real one.
- A **separate OpenRouter account** from `OPENROUTER_INFRA_KEY`. Drain the wrong
  one and your resolver dies and Aisle cannot recover itself.
- `LIMIT_PER_PURCHASE=10` in the demo env.
- Bootstrap the profile and save the card in autofill *before* the run, so
  checkout is a click and not a form fill.
- Expect 3DS. Have the HITL takeover path working, or you have no ending.

## Order

```
1. cloudflared tunnel            -> PUBLIC_MOCK_VENDOR_URL
2. update upstreams.json          -> origins match the tunnel
3. pnpm tsx scripts/steel-preflight.ts
4. bootstrap the mockvendor profile
5. FAKE_PURCHASE=0, run the slow lane against the mock site
6. (after freeze, optional) one real vendor on a virtual card
```

Do not start step 5 until step 3 is all green.
