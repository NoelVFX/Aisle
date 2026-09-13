# Integration guide

This package contains the Aisle recovery engine, including the fast lane,
slow lane, quote/policy/mandate modules, and a local MCP gateway. See
[README.md](README.md) for setup and [the pipeline specification](docs/aisle-pipeline.md)
for the full flow. Import shared contracts from `src/types.ts` or the package
root; both lanes use the same `RecoveryRequest` and `RecoveryResult`.

## Calling the fast lane

The caller supplies a checkpoint frozen from task configuration, a policy-checked
quote, and a signed mandate that has received human approval. The executor checks
that authorization before buying. It does not obtain approval itself.

```ts
import {
  connectMcpWebMcpSession, InMemoryIdempotencyStore, runFastLane,
  NoFastLaneError, PurchaseInFlightError,
} from "aisle";

// Create once for the host's lifetime, and share with the slow lane.
const store = new InMemoryIdempotencyStore();

// Inside a recovery handler; upstream and mandateSecret come from host config.
const session = await connectMcpWebMcpSession({
  provider: upstream.provider,
  url: upstream.mcpUrl,
  headers: { Authorization: `Bearer ${accountScopedToken}` },
});
try {
  const result = await runFastLane({ checkpoint, quote, mandate }, {
    session,
    store,
    mandateSecret,
    verifyRetry: { attempts: 3, delayMsBetween: 200 },
  });
  // Hand result.resumeToken.resumeAction back to the gateway for exact replay.
} catch (error) {
  if (error instanceof NoFastLaneError) {
    // Route the same request to runSlowLane with its browser dependencies.
  } else if (error instanceof PurchaseInFlightError) {
    // Wait for the existing attempt; do not launch another purchase.
  } else {
    throw error;
  }
} finally {
  await session.close();
}
```

`McpWebMcpSession` uses the official MCP SDK's Streamable HTTP transport and
accepts a `transport` override for other transports and in-process tests. Its
`provider` and endpoint URL must come from trusted task configuration. The URL's
origin is checked against the checkpoint's authorized API/billing origins.

## Shared contracts and signing

Use the current builders rather than constructing older standalone fast-lane
shapes:

- `lockOrigin(provider, upstream)` and `freezeCheckpoint(input)` produce the
  immutable task checkpoint, including the original tool call and arguments hash.
- `buildQuote(input)` returns `QUOTE`, `ALREADY_COVERED`, or `NO_VIABLE_OFFER`.
  A quote has top-level `productId`, `quantity`, `unitsGranted`, `price`,
  `currency`, and `billingOrigin` fields; there is no nested `quote.purchase`.
- `gate(quote, checkpoint, spend)` applies spending policy before approval.
- `signMandate(quote, { taskId, recoveryJobId, userId }, { secret })` returns
  a complete signed `PurchaseMandate`. It does not return just a signature.
- `verifyMandate(mandate, { secret })` validates signature, expiry, and terms.
  Both lanes use the same signing implementation in `src/mandate/mandate.ts`.

Pass the same secret to signing and to the executor's `mandateSecret`. The current
engine also reads `MANDATE_SECRET` and retains a development-only fallback;
configure an explicit secret for deployment. Never log or commit secrets.

Both executors accept `{ checkpoint, quote, mandate }` (plus an optional
`requirement`). Both return `lane`, `purchaseId`, `verifiedEntitlement`,
`resumeToken`, and `alreadyCovered`, plus `sessionViewerUrl` and `receiptFileIds`
from the slow lane when available. If the existing balance
already covers the requirement, no purchase is made and `purchaseId` is `null`.
The host replays `resumeToken.resumeAction` verbatim; it must not regenerate the
failed tool arguments.

## Vendor MCP contract

The adapter translates MCP tools into `WebMcpSession`. It prefers result
`structuredContent`, falling back to JSON text content. Vendor capability hints
belong in tool `_meta`:

```ts
_meta: { capability: "payment.purchase" } // or "payment.balance"
```

Custom fields inside MCP `annotations` may be stripped by SDK validation.
Recognizable purchase/balance tool names can also be detected without hints.

The purchase tool receives only mandate-derived arguments:

```ts
{ product_id: mandate.productId, quantity: mandate.quantity, idempotency_key: key }
```

The vendor resolves the product's price and units from its own catalogue and
should deduplicate on `idempotency_key`. It returns a transaction ID on success
or `isError: true` for an explicit refusal. A balance result provides `balance`,
`accountId`, and `resource` (normally `credits`). Purchase receipts alone never
establish entitlement.

## Persistence, retries, and errors

Share one `IdempotencyStore` across recovery attempts and lanes. The in-memory
implementation is for a single process; durable implementations must make
`claim` and `consumeMandate` atomic. Its contract is `get`, `claim`, `update`,
`consumeMandate`, and `forget`; the standalone branch's `putIfAbsent` API has
been superseded by `claim`.

| Outcome | Host action |
| --- | --- |
| `NoFastLaneError` | Use the slow lane; no purchase was attempted. |
| `MandateRejectedError` / `MandateMismatchError` | Fix the rejected authorization or checkout mismatch before proceeding. |
| `PurchaseInFlightError` | Wait for the attempt already holding the claim. |
| `PurchaseFailedError` | Inspect the error code. An explicit purchase refusal permits a fresh approved mandate; `BALANCE_READ_FAILED` does not prove that a prior purchase failed. |
| `PurchaseVerificationError` | Do not purchase again automatically. Reconcile observed entitlement with the existing attempt. |
| Transport exception after submission | Outcome may be unknown. Preserve the purchase record and re-read state before any further action. |

Fast-lane verification retries balance reads (default: three reads, 200ms apart),
never purchase calls. It checks the increase against `mandate.unitsGranted` and
rejects account or resource changes. A successful or ambiguous submission whose
balance is not yet confirmed stays `SUBMITTED` or `UNKNOWN`, blocking another
purchase even with a new mandate. A later recovery can resolve that record by
observing sufficient entitlement. Only an explicit purchase refusal marks the
attempt `FAILED` and allows a new claim. Mandates remain single-use.

After a verified recovery is handed back, the gateway may `forget` its record so
a later independent shortfall can be recovered. Never forget an unconfirmed
submission. Reusing a verified record still requires a current balance covering
the task's requirement.

## Slow-lane integration and verification

`runSlowLane` already implements browser purchasing with Steel. Supply its
browser provider, vendor adapter, profile store, and the shared idempotency
store. See [the demo](src/slow-lane-demo.ts) and
[the gateway purchaser](src/gateway/steel-purchaser.ts). Fallback to the slow lane
is for missing purchase capabilities, not for an ambiguous fast-lane charge.

Before shipping an integration, verify that configuration owns all origins,
both lanes share the same request types and signing secret, persistence survives
retries, human approval precedes execution, and the original tool call is replayed
only after entitlement verification. Run `npm run typecheck`, `npm test`, and
`npm run build`; `tests/mcp-http-session.test.ts` exercises real MCP protocol
framing with the SDK's in-memory transport.
