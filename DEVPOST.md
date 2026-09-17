# Aisle

Recovery layer that keeps AI agents alive when they hit a paywall.

## Inspiration

I handed my coding agent a task and walked away. Mid-run it called an image-generation MCP, hit a `402` — out of credits — and just died, printing a vague *"top up your credits on the website"* with no link and no amount. Everything it had built was lost, and I was left hunting for the vendor, guessing how many credits I needed, checking out by hand, then re-running the whole task from scratch. That wall was purely about money, not capability. **Aisle** makes sure an agent pauses and recovers instead of dying.

## What it does

When an agent's tool call fails for credits/quota, Aisle:

1. **Detects** the paywall (`402`, `insufficient_credits`, quota) and freezes a checkpoint of the exact call.
2. **Quotes** the *minimum* purchase that clears the shortfall.
3. **Asks the human once** — a single tap on a signed, origin- and amount-locked mandate.
4. **Buys** the credits on the user's own account (vendor API/WebMCP fast lane, or a real cloud browser slow lane).
5. **Verifies** the account balance actually moved.
6. **Replays** the original call so the agent resumes where it stalled.

A fatal wall becomes a short pause.

## How we built it

Aisle runs as an **MCP server** the agent connects to, proxying its vendor tools so it catches failures live.

- **Two lanes:** a fast lane over a vendor's purchase API/WebMCP; a slow lane driving a **Steel** cloud Chrome over CDP with **Playwright**, restoring a saved per-vendor login profile.
- **Resolver ladder** for unseen checkouts: schema.org offers → recorded click-paths → an LLM "picker" over the accessibility tree that only ever moves *toward* checkout.
- **Guardrails:** signed HMAC mandates (origin-locked, amount-capped), an origin lock on checkout, balance-delta verification, and one hard rule — **no model ever clicks submit**.

## Challenges we ran into

- **Bot detection** served an "unsupported browser" wall that looked like a logout; fixed with a stealth fingerprint kept identical across login and purchase sessions.
- **Promo modals** blocked clicks — the cursor "stuck" — so we dismiss overlays and bound every click to fail fast.
- **Menu-hidden balances** ("Credits 35 left" in an avatar dropdown) needed reveal + retry.
- **The LLM took the bait** — clicking "Upgrade 55% OFF" over the top-up — until we clicked the entry point deterministically, filtered upsells, and scrolled the pack into view.
- **A stale recorded path** misread a total as "$1"; our submit guard refused, and recordings now self-heal.

## Accomplishments that we're proud of

- A recovery that runs **end-to-end**: detect → approve → buy in a real browser → verify → replay.
- A safety model we never compromised to ship it.
- Site-specific hacks turned into **reusable, config-driven mechanisms**, so a new vendor is config, not code.
- **Withheld-submit mode** let us exercise the whole pipeline against real vendors for **$0**.

## What we learned

- The last mile is a **UI problem, not an AI problem** — modals, hidden state, scrolling, waiting.
- **Determinism beats cleverness** at the buy step; every time we trusted the model to find the path, a promo won.
- **Verify state, never trust receipts** — payments settle asynchronously.
- **Fail safe, loudly** — refusing to submit on a misread total beats "usually" being right.

## What's next for Aisle

- Auto-discovering balance and top-up surfaces so onboarding is near-zero config.
- One-tap mobile approvals with spend history and per-vendor ceilings.
- API-first balance reads wherever vendors expose them.
- The same detect → approve → recover → replay loop for expired tokens, rate limits, and any recoverable wall.

## Built with

- **TypeScript** / **Node.js** — the whole gateway, lanes, and resolver.
- **Model Context Protocol (MCP)** — Aisle runs as an MCP server the agent connects to.
- **Steel** — cloud Chrome sessions with saved per-vendor login profiles.
- **Playwright** over **Chrome DevTools Protocol (CDP)** — drives the slow-lane browser.
- **OpenRouter** — the LLM "picker" that stages checkouts (Qwen 3.7).
- **Stripe** (test mode) — payments on the demo vendor, verified with test card 4242.
- **HMAC** (Node crypto) — signed, origin- and amount-locked purchase mandates.
- **Vitest** — 300+ tests across the pipeline.
- **WSL2** — dev/runtime environment.
- Coding agents: **Hermes**, **Claude Code**, **Codex**.

## Tags

`mcp` · `ai-agents` · `browser-automation` · `steel` · `playwright` · `typescript` · `openrouter` · `agent-payments` · `stripe` · `fintech-infrastructure`
