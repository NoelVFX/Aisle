import { describe, it, expect } from "vitest";
import { createAgnicClient, type AgnicFetch } from "../src/agnic/client.js";
import { previewOrder, dispatchOrder, nextOrderAction, buildApprovedRequest, searchProducts } from "../src/agnic/commerce.js";
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
