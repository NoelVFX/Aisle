/**
 * Minimal Stripe REST client for the Studio demo vendor. TEST MODE ONLY:
 * any key that does not start with `sk_test_` is refused.
 */

export interface StripePack {
  id: string;
  credits: number;
  priceCents: number;
  label: string;
}

export interface StripeApi {
  createCustomer(email: string): Promise<{ id: string }>;
  /** Attaches pm_card_visa, then sets allow_redisplay=always on the returned id. */
  attachTestCard(customerId: string): Promise<{ id: string }>;
  createCheckoutSession(p: {
    customerId: string;
    pack: StripePack;
    account: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; url: string }>;
  retrieveCheckoutSession(id: string): Promise<{ id: string; payment_status: string; metadata?: Record<string, string> }>;
}

export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

/** Encode a nested object as Stripe-style form data: `a[b][0][c]=v`. */
export function encodeForm(data: Record<string, FormValue>): string {
  const pairs: string[] = [];
  const walk = (prefix: string, value: FormValue): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
      return;
    }
    pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(data)) walk(k, v);
  return pairs.join("&");
}

const API = "https://api.stripe.com/v1";

export function createStripeApi(secretKey: string, fetchImpl: typeof fetch = fetch): StripeApi {
  if (typeof secretKey !== "string" || !secretKey.startsWith("sk_test_")) {
    throw new Error("Studio demo vendor only runs in Stripe test mode: STRIPE_SECRET_KEY must start with sk_test_.");
  }

  async function call<T>(method: "GET" | "POST", path: string, body?: Record<string, FormValue>): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` };
    const init: RequestInit = { method, headers };
    if (body) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = encodeForm(body);
    }
    const res = await fetchImpl(`${API}${path}`, init);
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const msg =
        (json as { error?: { message?: string } } | undefined)?.error?.message ?? (text.slice(0, 200) || res.statusText);
      throw new Error(`Stripe ${method} ${path} failed (${res.status}): ${msg}`);
    }
    if (json === undefined) throw new Error(`Stripe ${method} ${path} returned non-JSON response`);
    return json as T;
  }

  return {
    async createCustomer(email) {
      const c = await call<{ id: string }>("POST", "/customers", { email });
      return { id: c.id };
    },
    async attachTestCard(customerId) {
      const pm = await call<{ id: string }>("POST", "/payment_methods/pm_card_visa/attach", { customer: customerId });
      await call<{ id: string }>("POST", `/payment_methods/${encodeURIComponent(pm.id)}`, { allow_redisplay: "always" });
      return { id: pm.id };
    },
    async createCheckoutSession(p) {
      const s = await call<{ id: string; url: string }>("POST", "/checkout/sessions", {
        mode: "payment",
        customer: p.customerId,
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: p.pack.priceCents,
              product_data: { name: `Studio ${p.pack.label}` },
            },
            quantity: 1,
          },
        ],
        payment_method_types: ["card"],
        metadata: { pack: p.pack.id, account: p.account },
        success_url: p.successUrl,
        cancel_url: p.cancelUrl,
      });
      return { id: s.id, url: s.url };
    },
    async retrieveCheckoutSession(id) {
      return call<{ id: string; payment_status: string; metadata?: Record<string, string> }>(
        "GET",
        `/checkout/sessions/${encodeURIComponent(id)}`,
      );
    },
  };
}
