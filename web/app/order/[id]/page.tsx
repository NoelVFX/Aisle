"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle, Package, Truck, MapPin, House, Copy } from "@phosphor-icons/react";
import Aurora from "@/components/Aurora";

const STEPS = [
  { label: "Order placed", sub: "We received your order", Icon: CheckCircle },
  { label: "Packed", sub: "Your item was prepared", Icon: Package },
  { label: "Shipped", sub: "Handed to the carrier", Icon: Truck },
  { label: "Out for delivery", sub: "On the way to you", Icon: MapPin },
  { label: "Delivered", sub: "Left at your door", Icon: House },
];
const CARRIERS = ["Northwind Express", "Cardinal Post", "Meridian Logistics"];

function hashInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}
const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

export default function OrderPage() {
  const [id, setId] = useState("");
  const [q, setQ] = useState<Record<string, string>>({});

  useEffect(() => {
    const parts = window.location.pathname.split("/").filter(Boolean);
    setId(decodeURIComponent(parts[parts.length - 1] || "order"));
    const params = new URLSearchParams(window.location.search);
    setQ({ item: params.get("item") || "Your order", amount: params.get("amount") || "", currency: params.get("currency") || "USD", merchant: params.get("merchant") || "the merchant" });
  }, []);

  const h = hashInt(id || "order");
  const current = (h % 3) + 2; // 2..4 (shipped / out-for-delivery / delivered)
  const carrier = CARRIERS[h % CARRIERS.length];
  const tracking = `AISLE-${(id || "order").replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase()}${(h % 9000) + 1000}`;
  const now = Date.now();
  const stepDate = (i: number) => fmtDate(new Date(now - (current - i) * 24 * 3600 * 1000));
  const delivered = current >= 4;
  const eta = fmtDate(new Date(now + Math.max(0, 4 - current) * 24 * 3600 * 1000));

  return (
    <>
      <Aurora />
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, position: "relative", zIndex: 1 }}>
        <div className="card card-pad" style={{ width: "min(560px, 100%)", display: "flex", flexDirection: "column", gap: 4, boxShadow: "0 24px 80px rgba(0,0,0,.35)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: "var(--muted)", fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase" }}>Order tracking</div>
              <div style={{ fontWeight: 660, fontSize: 20, letterSpacing: "-0.01em", marginTop: 2 }}>{delivered ? "Delivered" : "Out for delivery"}</div>
            </div>
            <a className="btn btn-ghost btn-sm" href="/"><ArrowLeft size={15} /> Back to Aisle</a>
          </div>

          <div style={{ color: "var(--text-2)", fontSize: 14, marginTop: 6 }}>{q.item}</div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", color: "var(--muted)", fontSize: 12.5, marginTop: 6 }}>
            <span>Order <span className="mono" style={{ color: "var(--text-2)" }}>{id}</span></span>
            {q.amount ? <span>Total <span className="mono" style={{ color: "var(--text-2)" }}>{q.currency === "USD" ? "$" : ""}{q.amount}</span></span> : null}
            <span>{delivered ? "Delivered" : `Arrives ${eta}`}</span>
          </div>

          <div style={{ height: 1, background: "var(--border)", margin: "16px 0 6px" }} />

          <div style={{ display: "flex", flexDirection: "column" }}>
            {STEPS.map((s, i) => {
              const done = i < current, active = i === current;
              const color = done || active ? "var(--accent)" : "var(--muted)";
              return (
                <div key={s.label} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", alignSelf: "stretch" }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", display: "grid", placeItems: "center", flex: "none", background: done ? "color-mix(in srgb, var(--accent) 18%, transparent)" : "var(--surface-3)", color, border: active ? "1px solid var(--accent)" : "1px solid transparent" }}>
                      <s.Icon size={17} weight={done ? "fill" : "bold"} />
                    </div>
                    {i < STEPS.length - 1 ? <div style={{ width: 2, flex: 1, minHeight: 26, background: i < current ? "var(--accent)" : "var(--border)", opacity: i < current ? 0.5 : 1 }} /> : null}
                  </div>
                  <div style={{ paddingBottom: 18, flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                      <span style={{ fontWeight: 560, color: done || active ? "var(--text)" : "var(--muted)" }}>{s.label}{active ? <span className="pulse" style={{ marginLeft: 8, display: "inline-block", verticalAlign: "middle" }} /> : null}</span>
                      <span className="mono" style={{ color: "var(--muted)", fontSize: 12.5 }}>{i <= current ? stepDate(i) : "—"}</span>
                    </div>
                    <div style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 2 }}>{s.sub}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px" }}>
            <div>
              <div style={{ color: "var(--muted)", fontSize: 12 }}>{carrier}</div>
              <div className="mono" style={{ fontSize: 14 }}>{tracking}</div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(tracking).catch(() => {})}><Copy size={14} /> Copy</button>
          </div>

          <div className="tag" style={{ marginTop: 12, alignSelf: "center", color: "var(--warn)", borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)" }}>
            Demo tracking. No real order or shipment.
          </div>
        </div>
      </div>
    </>
  );
}
