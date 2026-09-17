import { describe, it, expect } from "vitest";
import { runSlowLane } from "../src/slow-lane/executor.js";
import { FakeBrowserProvider, FakeShopAdapter, FakeShopSite } from "./helpers/fake-shop.js";
import { InMemoryIdempotencyStore, purchaseKeyFor } from "../src/fast-lane/idempotency.js";
import { resolveRequirement } from "../src/core/outcome.js";
import { PurchaseVerificationError } from "../src/index.js";
import { makeRequest, SECRET } from "./fixtures.js";

const PROVIDER = "mock-slow-vendor";
const ORIGIN = "https://shop.mock-slow-vendor.test";

describe("releasing a finished purchase record", () => {
  it("without release, a second wall of the same size in the same task is refused after the credits are spent", async () => {
    const site = new FakeShopSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const store = new InMemoryIdempotencyStore();
    const deps = { provider: new FakeBrowserProvider(site), adapter: new FakeShopAdapter(site), store, mandateSecret: SECRET };

    await runSlowLane(makeRequest({ provider: PROVIDER, origin: ORIGIN }), deps);
    site.balance = 0; // the task spent the credits
    await expect(runSlowLane(makeRequest({ provider: PROVIDER, origin: ORIGIN }), deps)).rejects.toBeInstanceOf(PurchaseVerificationError);
    expect(site.purchaseClicks).toBe(1);
  });

  it("after forget, the next wall buys again", async () => {
    const site = new FakeShopSite({ provider: PROVIDER, origin: ORIGIN, startingBalance: 0 });
    const store = new InMemoryIdempotencyStore();
    const deps = { provider: new FakeBrowserProvider(site), adapter: new FakeShopAdapter(site), store, mandateSecret: SECRET };

    const first = makeRequest({ provider: PROVIDER, origin: ORIGIN });
    await runSlowLane(first, deps);
    await store.forget(purchaseKeyFor(first.mandate, resolveRequirement(first)));

    site.balance = 0;
    const second = await runSlowLane(makeRequest({ provider: PROVIDER, origin: ORIGIN }), deps);
    expect(site.purchaseClicks).toBe(2);
    expect(second.verifiedEntitlement.balance).toBe(5000);
  });

  it("forget never drops a record whose outcome is still unknown", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.claim({ idempotencyKey: "k", mandateId: "m", purchaseId: "p", status: "PENDING" });
    await store.update("k", { status: "UNKNOWN" });
    await store.forget("k");
    expect((await store.get("k"))?.status).toBe("UNKNOWN");
  });
});
