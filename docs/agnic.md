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

If Agnic raises a step-up (passkey / expired CVV / currency), `wait_for_purchase` returns
`APPROVAL_REQUIRED` with a link — the user completes it, then Hermes calls
`aisle__wait_for_purchase` again. **Aisle dispatches at most once per approval** and never
polls by re-dispatching. It ends at the **receipt** — the user does their own setup and
integration in their coding agent afterwards.

## MCP tools

| Tool | Does |
|---|---|
| `aisle__shop` | Discover + price a purchase; returns a summary for one approval. `{ prompt, country?, merchant_id?, sku?, quantity?, explore_url? }` |
| `aisle__wait_for_purchase` | After approval, place the order and return the receipt. `{ shop_id }` |

The HTTP surface for approval: `GET /shop/:id` (the confirm page), `POST /api/shop/:id/approve`,
`GET /api/shop/:id/status`.

## How it maps to the API (HTTP, not the MCP token layer)

Base `https://api.agnic.ai`, header `X-Agnic-Token`.

| Step | Route |
|---|---|
| Discover by name | `GET /api/autofill/products/search?q=&country=` |
| Onboard a new shop | `POST /api/autofill/explore` → poll `GET /api/autofill/orders/{id}` until `explored` |
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
