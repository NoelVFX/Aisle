import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockVendor, type MockVendorHandle } from "../src/mock-vendor/server.js";
import { offersFromJsonLd } from "../src/slow-lane/adapters/ladder-adapter.js";
import { loadUpstreams } from "../src/gateway/upstreams.js";

let site: MockVendorHandle;
beforeAll(async () => {
  site = await startMockVendor({ port: 0 });
});
afterAll(async () => {
  await site.close();
});

const tool = (prompt: string) =>
  fetch(`${site.url}/tools/generate_image`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });

describe("mock vendor website", () => {
  it("serves JSON-LD offers the ladder can read", async () => {
    const page = await (await fetch(`${site.url}/pricing`)).text();
    const ld = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    const offers = offersFromJsonLd([JSON.parse(ld!)]);
    expect(offers.map((o) => [o.productId, o.unitsGranted, o.price])).toEqual([
      ["c1000", 1000, 5],
      ["c5000", 5000, 20],
      ["c25000", 25000, 80],
    ]);
    expect(page).toContain("<button type=\"submit\">Buy 5,000 credits</button>");
  });

  it("402s, sells credits through checkout exactly once per token, then serves the image", async () => {
    await fetch(`${site.url}/admin/reset`, { method: "POST", body: "{}" });
    expect((await tool("hero")).status).toBe(402);

    const checkout = await (await fetch(`${site.url}/checkout?p=c5000`)).text();
    expect(checkout).toContain('data-checkout-amount>20.00<');
    expect(checkout).toContain("data-checkout-period>one_time<");
    const token = checkout.match(/name="t" value="([^"]+)"/)?.[1]!;

    const confirm = (t: string) =>
      fetch(`${site.url}/confirm`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `p=c5000&t=${t}` });
    expect((await confirm(token)).status).toBe(200);
    expect((await confirm(token)).status).toBe(409); // double submit never double-charges
    expect(site.state.balance).toBe(5000);

    const account = await (await fetch(`${site.url}/account`)).text();
    expect(account).toContain("data-balance>5000<");

    const image = await tool("hero");
    expect(image.status).toBe(200);
    expect(((await image.json()) as { credits_remaining: number }).credits_remaining).toBe(5000 - 1067);
  });

  it("refuses admin routes that arrive through a tunnel", async () => {
    const res = await fetch(`${site.url}/admin/reset`, { method: "POST", headers: { "cf-connecting-ip": "1.2.3.4" }, body: "{}" });
    expect(res.status).toBe(403);
  });
});

describe("upstreams config", () => {
  it("resolves the mock vendor's origins from operator env and enables its slow lane", () => {
    const up = loadUpstreams(undefined, { MOCK_VENDOR_PUBLIC_URL: "https://abc.trycloudflare.com/", MOCK_VENDOR_URL: "http://127.0.0.1:8080" });
    expect(up["mockvendor"]).toMatchObject({
      billingOrigin: "https://abc.trycloudflare.com",
      billingUrl: "https://abc.trycloudflare.com/pricing",
      toolUrl: "http://127.0.0.1:8080",
      purchase: { mode: "slow-lane", realMoney: false },
    });
    expect(up["openai"]?.purchase?.realMoney).toBe(true);
  });

  it("without the mock website it falls back to the in-process mock and no slow lane", () => {
    const up = loadUpstreams(undefined, {});
    expect(up["mockvendor"]?.billingOrigin).toBe("https://example.com");
    expect(up["mockvendor"]?.toolUrl).toBeUndefined();
    expect(up["mockvendor"]?.purchase).toBeUndefined();
  });
});
