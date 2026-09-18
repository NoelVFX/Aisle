# Agnic commerce rail

Aisle is a **commerce agent**; Agnic is the **checkout engine**. Aisle discovers what to
buy, gets one human approval, and hands back a receipt. Agnic completes the real
checkout at almost any merchant — no merchant integration — with a **vaulted card** the
agent/model never sees, and returns **verifiable evidence** that it happened.

Aisle never places the payment itself and the model never types a card number.

## The workflow

```
User → Hermes: "buy me <thing> from <merchant>"   (or "top up credits on <site>")
Hermes → aisle__shop { prompt }                    (Aisle: discover + price)
  → AWAITING_APPROVAL { shop_id, approve_url, summary, total_minor, currency }
User opens approve_url → taps "Approve & buy"      (the one human approval = the mandate)
Hermes → aisle__wait_for_purchase { shop_id }      (Aisle: place + follow the order)
  → COMPLETED { receipt: { order_id, amount_charged_minor, currency, status, ... } }
```

### With discovery (the "I want a tool for X" flow)

When the user names a *goal* rather than a product — "I want an MCP tool for my site that
sends email autonomously" — start one step earlier. `aisle__find_tool` recommends the best-fit
SaaS/MCP tool and returns its **checkout URL**, which feeds straight into `aisle__shop`:

```
User → Hermes: "I want an MCP tool that sends email autonomously"
Hermes → aisle__find_tool { goal }                 (Aisle: OpenRouter LLM picks the tool + plan)
  → RECOMMENDED { tool_name: "Resend", checkout_url, plan: "Pro", why, alternatives }
Hermes → aisle__shop { prompt: "Resend plan", explore_url: <checkout_url>, plan: "Pro" }
                                                   (Aisle: known shop by domain, else Explore;
                                                    then read the merchant's catalogue)
  → CHOOSE_PLAN { merchant_id, plans: [{ sku, title, price_minor, currency, billing, recommended? }] }
User picks a plan                                  (the user chooses — never the agent)
Hermes → aisle__shop { prompt, merchant_id, sku: <chosen sku> }   (no explore_url: no second Explore)
  → AWAITING_APPROVAL → approve → aisle__wait_for_purchase → COMPLETED { receipt }
```

`aisle__find_tool` only *names* a tool, a URL, and a plan — it never pays. Agnic's product
*search* indexes vetted Shopify goods, not SaaS subscriptions, so the recommendation is an LLM
judgement (Qwen 3.7 Max by default, via `OPENROUTER_INFRA_KEY`; override with
`OPENROUTER_RECOMMEND_MODEL`). Aisle then completes the plan's checkout through Agnic's
**Explore-then-Pay** engine at that URL.

**How the plan/SKU is resolved.** The sku always comes from **Agnic's catalogue for that
merchant** — never from the model:
1. an explicit `sku` you pass wins;
2. else Aisle finds the merchant (known shop by domain → skip the ~2-min Explore, else Explore),
   then reads its catalogue via `GET /api/autofill/merchants/{id}`;
3. exactly one plan → straight to `AWAITING_APPROVAL`; an empty catalogue → `NO_CATALOGUE`
   (for a plan behind a sign-in, use `aisle__execute_web_action`, your own signed-in browser);
4. two or more → **`CHOOSE_PLAN`** with the plans; `plan` only sorts the closest match first and
   marks it `recommended` — it never picks. The user picks, then you call `aisle__shop` again
   with `merchant_id` + the chosen `sku` (no `explore_url`, so Explore never runs twice).

A recurring plan's approval summary says how it's billed (e.g. "billed monthly"). Digital plans
(no shipping) price straight to a total; physical goods still pick a delivery option.

> **Unverified until checked live:** the Agnic docs don't specify the catalogue's field name or
> shape in `GET /api/autofill/merchants/{id}`, so `getMerchantCatalogue` parses it defensively
> (`catalogue` / `catalog` / `products`, array or `{ items }`, optionally under `merchant`). Nor
> is it confirmed that preview prices merchants on non-Shopify rails, or what it returns for a
> digital plan with no delivery option. Check both against a live explored SaaS merchant.

If Agnic raises a step-up (passkey / expired CVV / currency), `wait_for_purchase` returns
`APPROVAL_REQUIRED` with a link — the user completes it, then Hermes calls
`aisle__wait_for_purchase` again. **Aisle dispatches at most once per approval** and never
polls by re-dispatching. It ends at the **receipt** — the user does their own setup and
integration in their coding agent afterwards.

## Personalised Explore (physical / Shopify track)

Agnic returns a flat product list; the **ranking, the pitch, and the learning are Aisle's** —
the part a bare Agnic wrapper can't copy. `aisle__browse` turns a search into a ranked, pitched
shortlist and learns from what the user actually buys.

```
User → "show me some blazers"
Hermes → aisle__browse { prompt: "blazer" }
  → Agnic search → rank by persona + learned conversion → assign each a DIFFERENT pitch tone
  → { products: [{ sku, title, price, merchant_id, tone, pitch, why }, …] }   (impression recorded)
User picks one → Hermes → aisle__shop { merchant_id, sku }  → AWAITING_APPROVAL
  → the pick is credited as a CONVERSION for that tone + attributes (tailors next time)
```

Three parts, one local **Preference Model** (`.aisle/personalization.json`, single-user, never
sent to the merchant or the LLM as identity):

1. **Multi-version pitches (A/B tones).** Each shown product gets a different tone — value,
   aspirational, social-proof, expert, playful — chosen by an **epsilon-greedy bandit**: mostly
   the tones that have converted for this user, occasionally the least-seen one to keep learning.
2. **Personalisation (consented).** `aisle__set_profile { consent, about }` distils a short
   self-description into coarse persona tags (e.g. *student, budget-conscious, smart-casual*) that
   boost matching products — so "uni student + blazer" surfaces the cost-friendly, young-cut one
   first. Stored only with `consent:true`; `consent:false` erases it.
3. **Memory + conversion learning.** Every impression and proceed-to-buy updates per-tone and
   per-attribute rates, so next session's shortlist is pre-tuned. The scoring is deliberately
   **explainable** (each item carries a `why`), and `PreferenceModel.stats()` exposes the rates.

Pitches and persona distillation use OpenRouter (`OPENROUTER_PITCH_MODEL`, default Qwen 3.7 Max)
with a **templated fallback**, so Explore works offline / without a key.

## How to invoke it (so the agent doesn't wander off)

### One entry, auto-routed: `aisle__buy`

`aisle__buy` is the single smart entry. It classifies the ask and routes to the right
engine, so the user never has to say which track they mean:

```
aisle__buy { prompt }
  → classifyTrack(prompt)
      ├─ physical good           → Agnic Shopify rail (aisle__shop internally)
      ├─ SaaS, vendor/URL known  → the vendor's own browser checkout (execute_web_action)
      └─ SaaS goal, no vendor    → discovery (find_tool) → confirm → buy
```

Classification is **heuristic-first** (free, instant keyword match) and only calls a
cheap OpenRouter model (Qwen 3.7 Max, `OPENROUTER_CLASSIFY_MODEL`) when the keywords are
ambiguous — and degrades to a keyword lean if no key is set, never blocking a purchase.
The result carries a `classification` field ({track, confidence, reason, source}) so the
routing is auditable. The lower-level `aisle__shop` / `aisle__find_tool` remain for callers
that already know the track.

### Trigger phrasing

How you trigger Aisle depends on the client:

- **Natural-language agents (Hermes CLI, most MCP clients):** there are no slash commands —
  the agent picks a tool by reading tool descriptions. Route to Aisle by **naming it and using
  a buy/act verb**:
  - Buy a product/plan: **"Use Aisle to buy a hex token fidget"**, "Use Aisle to purchase the
    Resend Pro plan".
  - Buy for a goal (discover first): **"Use Aisle to find and buy an MCP tool that sends email
    autonomously"** → runs `aisle__find_tool` then `aisle__shop`.
  - Act on / top up a site you use: **"Use Aisle to top up credits on higgsfield"**.

  The Aisle tool descriptions claim the verbs (buy/purchase/order/subscribe/check out/top up)
  and the phrase "use Aisle", so these route to `aisle__*` rather than a generic web tool.

- **Claude Code clients only:** the same flows are also exposed as MCP-prompt slash commands —
  `/mcp__aisle__buy <what to buy>` and `/mcp__aisle__topup <what to do>`. These do **not** exist
  in a plain natural-language CLI like Hermes (typing them there returns "unknown command").

> Prompts/slash commands are a per-client convenience; the **tools** (`aisle__shop`,
> `aisle__find_tool`, `aisle__wait_for_purchase`) are universal and are what actually run.

## MCP tools

| Tool | Does |
|---|---|
| `aisle__buy` | The single smart entry: classify physical vs SaaS and route (physical → Agnic; SaaS → vendor checkout / discovery). `{ prompt, country?, plan? }`. Never pays. |
| `aisle__browse` | Personalised Explore: a ranked, pitched shortlist over Agnic's Shopify catalogue. `{ prompt, country?, count? }` → `{ products: [{ sku, title, price_minor, currency, merchant_id, tone, pitch, why }] }`. The user picks one → `aisle__shop { merchant_id, sku }`. Never pays. |
| `aisle__set_profile` | Save/clear the user's local shopping profile (consented) so Explore is personalised. `{ consent, about?, budget_band?, country? }`. Stored locally only. |
| `aisle__find_tool` | Goal → best-fit SaaS/MCP tool + checkout URL + plan (LLM). `{ goal }` → `{ tool_name, checkout_url, plan, why, alternatives }`. Never pays. |
| `aisle__shop` | Discover + price a purchase; returns a summary for one approval, or `CHOOSE_PLAN { merchant_id, plans }` when a SaaS has several plans (pick, then call again with `merchant_id` + `sku`). `{ prompt, country?, merchant_id?, sku?, quantity?, explore_url?, plan? }` |
| `aisle__wait_for_purchase` | After approval, place the order and return the receipt. `{ shop_id }` |

The HTTP surface for approval: `GET /shop/:id` (the confirm page), `POST /api/shop/:id/approve`,
`GET /api/shop/:id/status`.

## How it maps to the API (HTTP, not the MCP token layer)

Base `https://api.agnic.ai`, header `X-Agnic-Token`.

| Step | Route |
|---|---|
| Discover by name | `GET /api/autofill/products/search?q=&country=` |
| Known shop by domain | `GET /api/autofill/merchants?q=<hostname>` (any rail; skips Explore) |
| Onboard a new shop | `POST /api/autofill/explore` → poll `GET /api/autofill/orders/{id}` until `explored` |
| Plans to choose from | `GET /api/autofill/merchants/{id}` — the merchant's catalogue (shape unverified) |
| Price (preview) | `POST /api/autofill/shopify/quote` |
| Place (dispatch) | `POST /api/autofill/dispatch` — `202` = approval still required |
| Step-up poll | `GET /api/approvals/{token}` until `approved` |
| Prove it happened | `GET /api/autofill/orders/{id}` — `succeeded` + `evidence`, `retryable`, `retry_action` |

Code: [`src/agnic/client.ts`](../src/agnic/client.ts), [`src/agnic/commerce.ts`](../src/agnic/commerce.ts),
[`src/agnic/manager.ts`](../src/agnic/manager.ts).

## Testing (free, real rail, no money)

Agnic's sandbox is a **real Shopify shop in Payments test mode** — everything real except
settlement. It works with the Stripe test card **4242 4242 4242 4242**.

1. Set `AGNIC_TOKEN` (from `https://app.agnic.ai`) in `.env`.
2. Vault a test card once at `https://app.agnic.ai/partner/cards/new` (Visa `4242…`).
3. Issue a spending mandate **in CAD** (the sandbox shop `untitled-fidget.shop` prices in CAD;
   a GBP mandate is refused forever with `currency_mismatch`).
4. `npm run gateway:http`, connect `aisle`, then:
   > "Buy me a hex token fidget" → approve at the link → `aisle__wait_for_purchase`.

Sandbox items are **1.00 CAD** (hex token fidget, paw print charm). No money moves, no parcel
ships. Note: sandbox orders still carry `test: false` (that field is about a *designated test
merchant*, which this isn't) — don't branch on it.

Three interruptions that are **not** failures: the CVV expires ~hourly (`cvv_refresh_required`),
a wrong-currency mandate is refused, and a step-up mints a new token each dispatch — so poll the
approval endpoint, never re-dispatch to poll. The manager handles all three.

The unit tests in [`tests/agnic-commerce.test.ts`](../tests/agnic-commerce.test.ts) exercise the
entire flow (discover → approve → dispatch-once → receipt, plus the 202 step-up) against a mock
backend, so the logic is verified without a live token.
