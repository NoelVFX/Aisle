import { describe, it, expect } from "vitest";
import { createAgnicClient, type AgnicFetch } from "../src/agnic/client.js";
import { previewOrder, dispatchOrder, nextOrderAction, buildApprovedRequest, searchProducts, getMerchantCatalogue, findMerchantByDomain } from "../src/agnic/commerce.js";
import { AgnicCommerceManager } from "../src/agnic/manager.js";

/** A scripted Agnic backend: handler(path, init) → {httpStatus, data}; records calls. */
function mockAgnic(handler: (path: string, init: { method?: string; body?: unknown }, i: number) => { httpStatus: number; data: Record<string, unknown> }): {
  agnic: AgnicFetch;
  calls: Array<{ path: string; method: string; body?: unknown }>;
} {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const agnic: AgnicFetch = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? "GET", body: init.body });
    return handler(path, init, calls.length - 1);
  };
  return { agnic, calls };
}

describe("agnic client", () => {
  it("sends X-Agnic-Token and JSON body, parses JSON", async () => {
    let seen: { url: string; headers: Record<string, string>; body?: string } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: init.body as string };
      return { status: 200, text: async () => JSON.stringify({ ok: true }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const agnic = createAgnicClient("secret-token", { fetchImpl: fake });
    const r = await agnic("/api/autofill/merchants", { method: "POST", body: { a: 1 } });
    expect(r).toEqual({ httpStatus: 200, data: { ok: true } });
    expect(seen?.url).toBe("https://api.agnic.ai/api/autofill/merchants");
    expect(seen?.headers["X-Agnic-Token"]).toBe("secret-token");
    expect(seen?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("turns a non-JSON (502 HTML) body into a readable code, and a throw into request_failed", async () => {
    const html = (async () => ({ status: 502, text: async () => "<html>Bad Gateway</html>" }) as unknown as Response) as unknown as typeof fetch;
    const a1 = createAgnicClient("t", { fetchImpl: html });
    expect((await a1("/x")).data["error"]).toBe("non_json_response");
    const boom = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const a2 = createAgnicClient("t", { fetchImpl: boom });
    const r = await a2("/x");
    expect(r.httpStatus).toBe(0);
    expect(r.data["error"]).toBe("request_failed");
  });

  it("requires a token", () => {
    expect(() => createAgnicClient("")).toThrow(/AGNIC_TOKEN/);
  });
});

describe("preview (quote)", () => {
  it("returns choose_delivery when a fulfillment choice is required, then ready once chosen", async () => {
    const { agnic } = mockAgnic((path, init) => {
      const body = (init.body ?? {}) as { fulfillment_option_id?: string };
      if (path.startsWith("/api/autofill/shopify/quote")) {
        if (!body.fulfillment_option_id)
          return { httpStatus: 200, data: { requires_fulfillment_choice: true, fulfillment_options: [{ id: "F1", type: "shipping", amount_minor: 0, label: "Std" }] } };
        return { httpStatus: 200, data: { expected_amount_minor: 100, currency: "CAD", amount_is_final: true, selected_option_id: "F1", fulfillment_options: [{ id: "F1", type: "shipping", amount_minor: 0 }] } };
      }
      return { httpStatus: 404, data: {} };
    });
    const first = await previewOrder(agnic, { merchant_id: "M1", items: [{ sku: "S1", quantity: 1 }] });
    expect(first.state).toBe("choose_delivery");
    const ready = await previewOrder(agnic, { merchant_id: "M1", items: [{ sku: "S1", quantity: 1 }], fulfillment_option_id: "F1" });
    expect(ready.state).toBe("ready");
    if (ready.state === "ready") { expect(ready.expected_amount_minor).toBe(100); expect(ready.currency).toBe("CAD"); }
  });

  it("surfaces unfulfillable and refusals", async () => {
    const un = mockAgnic(() => ({ httpStatus: 200, data: { unfulfillable: true } }));
    expect((await previewOrder(un.agnic, { merchant_id: "M", items: [{ sku: "S", quantity: 1 }] })).state).toBe("unfulfillable");
    const ref = mockAgnic(() => ({ httpStatus: 409, data: { error: "shopify_amount_changed" } }));
    const r = await previewOrder(ref.agnic, { merchant_id: "M", items: [{ sku: "S", quantity: 1 }] });
    expect(r.state).toBe("refused");
  });

  it("treats a digital plan (priced, no fulfillment options) as ready", async () => {
    const { agnic } = mockAgnic(() => ({ httpStatus: 200, data: { expected_amount_minor: 2000, currency: "USD", amount_is_final: true, line_item: "Pro plan", fulfillment_options: [] } }));
    const r = await previewOrder(agnic, { merchant_id: "M", items: [{ sku: "pro", quantity: 1 }] });
    expect(r.state).toBe("ready");
    if (r.state === "ready") { expect(r.expected_amount_minor).toBe(2000); expect(r.request.fulfillment_option_id).toBeUndefined(); }
  });
});

describe("dispatch", () => {
  const req = () => buildApprovedRequest(
    { state: "ready", request: { merchant_id: "M1", items: [{ sku: "S1", quantity: 1 }], fulfillment_option_id: "F1" }, expected_amount_minor: 100, currency: "CAD", amount_is_final: true },
    { text: "yes", approvedAt: new Date().toISOString() },
  );

  it("poll on order_id, approval_required on 202, refused on 409, reconcile otherwise", async () => {
    expect((await dispatchOrder(mockAgnic(() => ({ httpStatus: 200, data: { order_id: "O1" } })).agnic, req())).state).toBe("poll");
    const ar = await dispatchOrder(mockAgnic(() => ({ httpStatus: 202, data: { approval_required: true, approval_token: "T", approval_url: "http://a", expires_in: 300, reason: "cvv_refresh_required" } })).agnic, req());
    expect(ar).toMatchObject({ state: "approval_required", token: "T", reason: "cvv_refresh_required" });
    expect((await dispatchOrder(mockAgnic(() => ({ httpStatus: 409, data: { error: "cap" } })).agnic, req())).state).toBe("refused");
    expect((await dispatchOrder(mockAgnic(() => ({ httpStatus: 500, data: {} })).agnic, req())).state).toBe("reconcile");
  });

  it("buildApprovedRequest rejects a missing confirmation", () => {
    const q = { state: "ready" as const, request: { merchant_id: "M", items: [] }, expected_amount_minor: 1, currency: "CAD", amount_is_final: true };
    expect(() => buildApprovedRequest(q, { text: "", approvedAt: "nope" })).toThrow();
  });
});

describe("nextOrderAction", () => {
  it("classifies terminal states safely", () => {
    expect(nextOrderAction({ status: "succeeded", retryable: false })).toBe("capture_once");
    expect(nextOrderAction({ status: "processing", retry_action: "poll", retryable: null })).toBe("poll_later");
    expect(nextOrderAction({ retry_action: "handoff", retryable: false })).toBe("human_handoff");
    expect(nextOrderAction({ status: "failed", retryable: null })).toBe("reconcile"); // money may have moved
    expect(nextOrderAction({ status: "refused", retryable: true, retry_action: "re_preview", evidence: { charge_state: "none" } })).toBe("release_hold_once");
  });
});

describe("AgnicCommerceManager end-to-end", () => {
  function scriptedManager(overrides?: (path: string, i: number) => { httpStatus: number; data: Record<string, unknown> } | undefined) {
    let dispatches = 0;
    const { agnic, calls } = mockAgnic((path, init) => {
      const ov = overrides?.(path, calls.length);
      if (ov) return ov;
      if (path.startsWith("/api/autofill/products/search")) return { httpStatus: 200, data: { products: [{ sku: "S1", title: "Hex fidget", available: true, price_minor: 100, currency: "CAD", merchant: { merchant_id: "M1" } }] } };
      if (path.startsWith("/api/autofill/shopify/quote")) {
        const b = (init.body ?? {}) as { fulfillment_option_id?: string };
        if (!b.fulfillment_option_id) return { httpStatus: 200, data: { requires_fulfillment_choice: true, fulfillment_options: [{ id: "F1", type: "shipping", amount_minor: 0 }] } };
        return { httpStatus: 200, data: { expected_amount_minor: 100, currency: "CAD", amount_is_final: true, selected_option_id: "F1", line_item: "Hex fidget", fulfillment_options: [{ id: "F1", type: "shipping", amount_minor: 0 }] } };
      }
      if (path === "/api/autofill/dispatch") { dispatches++; return { httpStatus: 200, data: { order_id: "O1" } }; }
      if (path.startsWith("/api/autofill/orders/")) return { httpStatus: 200, data: { id: "O1", status: "succeeded", amount_charged_minor: 100, currency: "CAD", retryable: false, retry_action: "none", evidence: { charge_state: "charged" } } };
      return { httpStatus: 404, data: {} };
    });
    const mgr = new AgnicCommerceManager({ agnic, publicUrl: () => "http://127.0.0.1:8787", defaultCountry: "CA", pollMs: 0 });
    return { mgr, calls, dispatches: () => dispatches };
  }

  it("discover → approve → dispatch once → receipt", async () => {
    const { mgr, dispatches } = scriptedManager();
    const started = await mgr.shop({ taskId: "t", prompt: "a hex token fidget" });
    expect(started.status).toBe("AWAITING_APPROVAL");
    if (started.status !== "AWAITING_APPROVAL") return;
    expect(started.total_minor).toBe(100);
    expect(started.currency).toBe("CAD");
    expect(started.approve_url).toMatch(/\/shop\//);

    // Not approved yet → still awaiting, no dispatch.
    expect((await mgr.wait(started.shop_id)).status).toBe("AWAITING_APPROVAL");
    expect(dispatches()).toBe(0);

    expect(mgr.approve(started.shop_id, "yes buy it").ok).toBe(true);
    const done = await mgr.wait(started.shop_id);
    expect(done.status).toBe("COMPLETED");
    if (done.status === "COMPLETED") {
      expect(done.receipt.order_id).toBe("O1");
      expect(done.receipt.amount_charged_minor).toBe(100);
      expect(done.receipt.currency).toBe("CAD");
      expect(done.receipt.status).toBe("succeeded");
    }
    expect(dispatches()).toBe(1); // dispatched exactly once
  });

  it("surfaces a 202 step-up, then completes after the approval clears (never re-dispatch to poll)", async () => {
    let stage = 0;
    const { mgr } = scriptedManager((path) => {
      if (path === "/api/autofill/dispatch") {
        stage++;
        if (stage === 1) return { httpStatus: 202, data: { approval_required: true, approval_token: "T1", approval_url: "http://a", reason: "cvv_refresh_required" } };
        return { httpStatus: 200, data: { order_id: "O2" } };
      }
      if (path.startsWith("/api/approvals/")) return { httpStatus: 200, data: { status: "approved" } };
      if (path.startsWith("/api/autofill/orders/")) return { httpStatus: 200, data: { id: "O2", status: "succeeded", amount_charged_minor: 100, currency: "CAD", retryable: false, retry_action: "none", evidence: { charge_state: "charged" } } };
      return undefined;
    });
    const started = await mgr.shop({ taskId: "t", prompt: "a hex token fidget" });
    if (started.status !== "AWAITING_APPROVAL") throw new Error("expected AWAITING_APPROVAL");
    mgr.approve(started.shop_id);
    const stepUp = await mgr.wait(started.shop_id);
    expect(stepUp.status).toBe("APPROVAL_REQUIRED");
    if (stepUp.status === "APPROVAL_REQUIRED") expect(stepUp.reason).toBe("cvv_refresh_required");
    const done = await mgr.wait(started.shop_id); // polls approval, re-dispatches once, completes
    expect(done.status).toBe("COMPLETED");
  });
});

describe("merchant catalogue + lookup by domain", () => {
  it("parses the catalogue under alternate keys and shapes, keeping only buyable entries with a sku", async () => {
    const plans = [
      { sku: "p1", title: "Pro", price_minor: 2000, currency: "USD", billing: "month" },
      { sku: "p2", name: "Scale", amount_minor: 9000, interval: "year", available: true },
      { sku: "gone", title: "Legacy", available: false },
      { title: "no sku" },
      "junk",
    ];
    const shapes: Array<Record<string, unknown>> = [
      { id: "M1", catalogue: plans },
      { id: "M1", catalog: { items: plans } },
      { id: "M1", products: plans },
      { merchant: { id: "M1", catalogue: { items: plans } } },
      { merchant: { id: "M1", catalog: plans } },
    ];
    for (const shape of shapes) {
      const { agnic, calls } = mockAgnic(() => ({ httpStatus: 200, data: shape }));
      const items = await getMerchantCatalogue(agnic, "M1");
      expect(calls[0]?.path).toBe("/api/autofill/merchants/M1");
      expect(items).toEqual([
        { sku: "p1", title: "Pro", price_minor: 2000, currency: "USD", billing: "month" },
        { sku: "p2", title: "Scale", price_minor: 9000, available: true, billing: "year" },
      ]);
    }
  });

  it("returns [] for a merchant without a catalogue, encodes the id, and throws on non-200", async () => {
    const none = mockAgnic(() => ({ httpStatus: 200, data: { id: "M/1", name: "Shop" } }));
    expect(await getMerchantCatalogue(none.agnic, "M/1")).toEqual([]);
    expect(none.calls[0]?.path).toBe("/api/autofill/merchants/M%2F1");
    const missing = mockAgnic(() => ({ httpStatus: 404, data: { error: "not_found" } }));
    await expect(getMerchantCatalogue(missing.agnic, "M1")).rejects.toThrow(/HTTP 404/);
  });

  it("finds a known merchant by the URL's domain on any rail, ignoring www.", async () => {
    const { agnic, calls } = mockAgnic(() => ({
      httpStatus: 200,
      data: { merchants: [{ id: "MX", domain: "notresend.com", rail: "shopify" }, { id: "M9", name: "Resend", domain: "www.resend.com", rail: "worker" }] },
    }));
    const m = await findMerchantByDomain(agnic, "https://resend.com/pricing");
    expect(m).toEqual({ id: "M9", name: "Resend", domain: "www.resend.com", rail: "worker" });
    expect(calls[0]?.path).toBe("/api/autofill/merchants?q=resend.com");
  });

  it("treats no match, a non-200 or a bad URL as not found", async () => {
    const other = mockAgnic(() => ({ httpStatus: 200, data: { merchants: [{ id: "MX", domain: "example.com" }] } }));
    expect(await findMerchantByDomain(other.agnic, "https://www.resend.com/pricing")).toBeUndefined();
    const down = mockAgnic(() => ({ httpStatus: 502, data: { error: "non_json_response" } }));
    expect(await findMerchantByDomain(down.agnic, "https://resend.com/pricing")).toBeUndefined();
    const bad = mockAgnic(() => ({ httpStatus: 200, data: { merchants: [] } }));
    expect(await findMerchantByDomain(bad.agnic, "not a url")).toBeUndefined();
  });
});

describe("AgnicCommerceManager plan picker (explore → CHOOSE_PLAN → pick → approval)", () => {
  const TWO_PLANS = [
    { sku: "resend-pro", title: "Pro", price_minor: 2000, currency: "USD", billing: "month" },
    { sku: "resend-scale", title: "Scale", price_minor: 9000, currency: "USD", billing: "month" },
  ];

  /** Agnic that doesn't know resend.com yet (unless `known`), explores it to M9, and quotes any sku. */
  function planManager(opts: { catalogue: Record<string, unknown>; known?: boolean }) {
    const { agnic, calls } = mockAgnic((path, init) => {
      if (path.startsWith("/api/autofill/merchants?")) {
        return { httpStatus: 200, data: { merchants: opts.known ? [{ id: "M9", name: "Resend", domain: "resend.com", rail: "worker" }] : [{ id: "MX", domain: "example.com" }] } };
      }
      if (path === "/api/autofill/explore") return { httpStatus: 200, data: { order_id: "E1", status: "explored", merchant_id: "M9" } };
      if (path === "/api/autofill/merchants/M9") return { httpStatus: 200, data: opts.catalogue };
      if (path.startsWith("/api/autofill/shopify/quote")) {
        const b = (init.body ?? {}) as { items?: Array<{ sku: string }> };
        const amount = b.items?.[0]?.sku === "resend-scale" ? 9000 : 2000;
        return { httpStatus: 200, data: { expected_amount_minor: amount, currency: "USD", amount_is_final: true, selected_option_id: "D1", fulfillment_options: [{ id: "D1", type: "digital", amount_minor: 0 }] } };
      }
      return { httpStatus: 404, data: {} };
    });
    const mgr = new AgnicCommerceManager({ agnic, publicUrl: () => "http://127.0.0.1:8787", defaultCountry: "US", pollMs: 0 });
    const count = (pred: (c: { path: string; method: string }) => boolean) => calls.filter(pred).length;
    return {
      mgr,
      calls,
      explores: () => count((c) => c.path === "/api/autofill/explore"),
      quotes: () => count((c) => c.path.startsWith("/api/autofill/shopify/quote")),
      dispatches: () => count((c) => c.path === "/api/autofill/dispatch"),
    };
  }

  it("explores an unknown shop once, then returns CHOOSE_PLAN with every plan (nothing priced or placed)", async () => {
    const { mgr, explores, quotes, dispatches } = planManager({ catalogue: { id: "M9", catalogue: TWO_PLANS } });
    const r = await mgr.shop({ taskId: "t", prompt: "Resend plan", exploreUrl: "https://resend.com/pricing" });
    expect(r.status).toBe("CHOOSE_PLAN");
    if (r.status !== "CHOOSE_PLAN") return;
    expect(r.merchant_id).toBe("M9");
    expect(r.plans).toEqual([
      { sku: "resend-pro", title: "Pro", price_minor: 2000, currency: "USD", billing: "month" },
      { sku: "resend-scale", title: "Scale", price_minor: 9000, currency: "USD", billing: "month" },
    ]);
    expect(r.next).toMatch(/do not choose for them/);
    expect(r.next).toMatch(/merchant_id and the chosen sku/);
    expect(explores()).toBe(1);
    expect(quotes()).toBe(0);
    expect(dispatches()).toBe(0);
  });

  it("puts the plan matching plan_hint first and marks it recommended — but still lets the user choose", async () => {
    const { mgr } = planManager({ catalogue: { id: "M9", catalogue: TWO_PLANS } });
    const r = await mgr.shop({ taskId: "t", prompt: "Resend plan", exploreUrl: "https://resend.com/pricing", planHint: "scale (~$90/month)" });
    expect(r.status).toBe("CHOOSE_PLAN");
    if (r.status !== "CHOOSE_PLAN") return;
    expect(r.plans.map((p) => p.sku)).toEqual(["resend-scale", "resend-pro"]);
    expect(r.plans[0]?.recommended).toBe(true);
    expect(r.plans[1]?.recommended).toBeUndefined();
  });

  it("the follow-up (merchant_id + chosen sku) goes straight to approval without exploring again, and says it recurs", async () => {
    const { mgr, explores, calls } = planManager({ catalogue: { id: "M9", catalogue: TWO_PLANS } });
    const choose = await mgr.shop({ taskId: "t", prompt: "Resend plan", exploreUrl: "https://resend.com/pricing" });
    if (choose.status !== "CHOOSE_PLAN") throw new Error("expected CHOOSE_PLAN");
    const before = calls.length;

    const picked = await mgr.shop({ taskId: "t", prompt: "Resend plan", merchantId: choose.merchant_id, sku: "resend-scale" });
    expect(picked.status).toBe("AWAITING_APPROVAL");
    if (picked.status !== "AWAITING_APPROVAL") return;
    expect(picked.merchant_id).toBe("M9");
    expect(picked.total_minor).toBe(9000);
    expect(picked.summary).toMatch(/^Scale — /);
    expect(picked.summary).toMatch(/billed monthly/);
    expect(explores()).toBe(1); // not explored again
    // The follow-up only priced the chosen sku: no lookup, no explore, no catalogue read.
    const followUp = calls.slice(before);
    expect(followUp.map((c) => c.path)).toEqual(["/api/autofill/shopify/quote"]);
    expect((followUp[0]?.body as { items: Array<{ sku: string }> }).items[0]?.sku).toBe("resend-scale");
  });

  it("a catalogue with exactly one plan goes straight to preview → AWAITING_APPROVAL", async () => {
    const { mgr, explores } = planManager({ catalogue: { id: "M9", catalog: { items: [{ sku: "resend-pro", title: "Pro", billing: "monthly" }] } } });
    const r = await mgr.shop({ taskId: "t", prompt: "Resend plan", exploreUrl: "https://resend.com/pricing" });
    expect(r.status).toBe("AWAITING_APPROVAL");
    if (r.status !== "AWAITING_APPROVAL") return;
    expect(r.total_minor).toBe(2000);
    expect(r.summary).toMatch(/^Pro — .*billed monthly/);
    expect(explores()).toBe(1);
  });

  it("an empty catalogue fails with NO_CATALOGUE and points at the signed-in browser path", async () => {
    const { mgr, quotes } = planManager({ catalogue: { id: "M9", catalogue: [] } });
    const r = await mgr.shop({ taskId: "t", prompt: "Resend plan", exploreUrl: "https://resend.com/pricing" });
    expect(r.status).toBe("FAILED");
    if (r.status !== "FAILED") return;
    expect(r.error).toMatch(/^NO_CATALOGUE: explored https:\/\/resend\.com\/pricing/);
    expect(r.error).toMatch(/aisle__execute_web_action/);
    expect(quotes()).toBe(0);
  });

  it("a shop Agnic already knows (by domain) skips Explore", async () => {
    const { mgr, explores, calls } = planManager({ catalogue: { id: "M9", catalogue: TWO_PLANS }, known: true });
    const r = await mgr.shop({ taskId: "t", prompt: "Resend plan", exploreUrl: "https://www.resend.com/pricing" });
    expect(r.status).toBe("CHOOSE_PLAN");
    expect(explores()).toBe(0);
    expect(calls.map((c) => c.path)).toEqual(["/api/autofill/merchants?q=resend.com", "/api/autofill/merchants/M9"]);
  });

  it("an explore_url with a sku still buys that sku directly (no catalogue read)", async () => {
    const { mgr, calls } = planManager({ catalogue: { id: "M9", catalogue: TWO_PLANS } });
    const r = await mgr.shop({ taskId: "t", prompt: "Resend plan", exploreUrl: "https://resend.com/pricing", sku: "resend-pro" });
    expect(r.status).toBe("AWAITING_APPROVAL");
    expect(calls.some((c) => c.path === "/api/autofill/merchants/M9")).toBe(false);
  });
});
