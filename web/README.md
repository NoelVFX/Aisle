# Aisle — web app

A premium chat interface where you talk to the **Aisle** commerce agent. It surfaces the
full agentic-checkout experience: personalised discovery, tone-tested pitches, one-tap
approval, checkout complements, receipts, and SaaS tool discovery.

Built with Next.js (App Router) + Geist. Ships with a **demo agent** so it deploys and demos
on its own, with a hook to point at a live Aisle gateway.

## Run locally

```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000.

## Supabase authentication

Copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. Run `supabase/migrations/001_profiles.sql` in
the Supabase SQL editor first.

If the database was already configured from the earlier profile schema, also
run `supabase/migrations/002_repair_profile_trigger.sql`. It repairs the auth
trigger and prevents profile metadata problems from blocking signup.

In Supabase Authentication → URL Configuration, add these redirect URLs:

```text
http://localhost:3000/auth/confirm
https://your-production-domain.com/auth/confirm
```

### Email verification: pick one

Supabase's **default** "Confirm signup" email sends a **link** (to your Site URL,
which on dev is `http://localhost:3000`), not a 6-digit code. The verify screen
accepts either, but choose the flow you want:

- **Fastest for a demo, no email step:** Authentication → Providers → Email →
  turn **Confirm email OFF**. Signup then signs the user in immediately. (Re-enable
  it for production.)

- **Send a real 6-digit OTP:** requires editing the email template, which Supabase
  only allows for the project **Owner/Admin** and often only after you configure a
  **custom SMTP** provider (otherwise the editor is read-only). If you can edit it:
  Authentication → Email Templates → **Confirm signup**, and put the token in the body, e.g.

  ```html
  <h2>Confirm your signup</h2>
  <p>Your Aisle verification code is: <strong>{{ .Token }}</strong></p>
  ```

  Then enter that code on the verify screen.

- **Keep the default link:** just **click the link** in the email (Aisle confirms it
  at `/auth/confirm` and signs you in), or **paste the whole link** into the verify
  box. Make sure `.../auth/confirm` is in Authentication → URL Configuration →
  Redirect URLs (above), and set **Site URL** to your real domain for production so
  the link is not localhost.

## Deploy on Vercel

1. Push this repo to GitHub (already on the `Agnic` branch).
2. In Vercel, **New Project** from the repo and set **Root Directory** to `web`.
3. Framework preset auto-detects **Next.js**. Build command `next build`, output handled by Vercel.
4. Deploy. No environment variables are required for demo mode.

Or from the CLI:

```bash
cd web
npx vercel --prod
```

## What the demo shows

| Try this | You get |
|---|---|
| "Show me a blazer" / "Find me a keyboard" | A ranked, pitched shortlist (each card in a different tone) |
| Click a product | The approval card: total, vaulted-card mandate, and "frequently bought together" |
| "Approve and buy" | A verified receipt |
| "Set up my profile" | Consent-gated persona capture that re-ranks results |
| "I need an MCP tool that sends email" | A SaaS recommendation (Resend) with a buyable plan |
| "My For You" | Empty for a first-time user; fills after a purchase |

## Real products (Agnic) and intelligent chat (OpenRouter)

Products shown are **real Shopify products pulled live from Agnic** (title, price, image, sku),
never fabricated. Only the tone pitch on each card is written by the LLM. Set these env vars
(locally in `.env.local`, or in the Vercel project):

- `AGNIC_TOKEN` — required for browse. Without it, browse says "connect Agnic" and shows nothing.
- `OPENROUTER_API_KEY` — makes chat answer real questions and write the pitches. This project's
  key blocks OpenAI/Google/Anthropic providers, so the default model is `deepseek/deepseek-chat-v3.1`
  (override with `AISLE_CHAT_MODEL`).

## Wiring to a live Aisle gateway (optional)

The chat endpoint is [`app/api/chat/route.ts`](app/api/chat/route.ts). In demo mode it runs the
scripted agent in [`lib/agent.ts`](lib/agent.ts). To drive a real Aisle gateway, forward the
request there instead (its MCP tools: `aisle__browse`, `aisle__set_profile`, `aisle__shop`,
`aisle__wait_for_purchase`). Note the gateway runs Playwright and Agnic calls, so it must run
on a persistent host, not Vercel serverless. Point the web app at it with a base URL env var.

## Design notes

One dark theme, one accent (electric lime, carried over from the approval page), one radius
system. Geist + Geist Mono. Motion uses Emil Kowalski's `ease-out` curve, `scale(0.97)` press
feedback, and short stagger, all under 300ms and disabled under `prefers-reduced-motion`. No
em-dashes in UI copy. Real empty, loading (skeleton), and error states.
