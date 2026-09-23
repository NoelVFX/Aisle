"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft, CheckCircle, Package, Truck, MapPin, House, Copy, XCircle,
  PaperPlaneRight, ChatCircleDots,
} from "@phosphor-icons/react";
import Aurora from "@/components/Aurora";

const STEPS = [
  { label: "Order placed", sub: "We received your order", Icon: CheckCircle },
  { label: "Packed", sub: "Your item was prepared", Icon: Package },
  { label: "Shipped", sub: "Handed to the carrier", Icon: Truck },
  { label: "Out for delivery", sub: "On the way to you", Icon: MapPin },
  { label: "Delivered", sub: "Left at your door", Icon: House },
];
const CARRIERS = ["Northwind Express", "Cardinal Post", "Meridian Logistics"];
const QUICK = ["How's it going?", "Cancel order", "Change delivery address", "Change delivery date"];

function hashInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}
const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const DAY = 24 * 3600 * 1000;

/** Parse a loose date phrase into a display date. Falls back to the raw text. */
function parseDate(t: string): string {
  const lc = t.toLowerCase();
  const now = Date.now();
  if (/tomorrow/.test(lc)) return fmtDate(new Date(now + DAY));
  if (/today|asap|now/.test(lc)) return fmtDate(new Date(now));
  if (/day after tomorrow/.test(lc)) return fmtDate(new Date(now + 2 * DAY));
  if (/next week/.test(lc)) return fmtDate(new Date(now + 7 * DAY));
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const di = days.findIndex((d) => lc.includes(d));
  if (di >= 0) { const cur = new Date().getDay(); let add = (di - cur + 7) % 7; if (add === 0) add = 7; return fmtDate(new Date(now + add * DAY)); }
  return t.trim().replace(/^(on|to|for)\s+/i, "").slice(0, 40);
}

type Msg = { role: "user" | "aisle"; text: string };

export default function OrderPage() {
  const [id, setId] = useState("");
  const [q, setQ] = useState<Record<string, string>>({ item: "Your order", amount: "", currency: "USD", merchant: "the merchant" });
  const [cancelled, setCancelled] = useState(false);
  const [address, setAddress] = useState("128 Rowan Street, Apt 4B");
  const [etaText, setEtaText] = useState<string>();
  const [awaiting, setAwaiting] = useState<null | "address" | "date">(null);
  const [msgs, setMsgs] = useState<Msg[]>([{ role: "aisle", text: "Ask me anything about this order, or use a shortcut. I can cancel it, change the address, or reschedule delivery." }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parts = window.location.pathname.split("/").filter(Boolean);
    setId(decodeURIComponent(parts[parts.length - 1] || "order"));
    const params = new URLSearchParams(window.location.search);
    setQ({ item: params.get("item") || "Your order", amount: params.get("amount") || "", currency: params.get("currency") || "USD", merchant: params.get("merchant") || "the merchant" });
  }, []);
  useEffect(() => { scRef.current?.scrollTo({ top: scRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);

  const h = hashInt(id || "order");
  const current = cancelled ? -1 : (h % 3) + 2; // 2..4 (shipped / out-for-delivery / delivered)
  const carrier = CARRIERS[h % CARRIERS.length];
  const tracking = `AISLE-${(id || "order").replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase()}${(h % 9000) + 1000}`;
  const now = Date.now();
  const stepDate = (i: number) => fmtDate(new Date(now - (((h % 3) + 2) - i) * DAY));
  const delivered = !cancelled && (h % 3) + 2 >= 4;
  const baseEta = fmtDate(new Date(now + Math.max(0, 4 - ((h % 3) + 2)) * DAY));
  const statusLabel = cancelled ? "Cancelled" : delivered ? "Delivered" : "Out for delivery";
  const etaDisplay = cancelled ? "Cancelled" : delivered ? "Delivered" : `Arrives ${etaText ?? baseEta}`;
  const amountDisplay = q.amount ? `${q.currency === "USD" ? "$" : ""}${q.amount}` : "";

  const say = (text: string) => setMsgs((m) => [...m, { role: "aisle", text }]);

  const send = async (raw: string) => {
    const t = raw.trim();
    if (!t || busy) return;
    setMsgs((m) => [...m, { role: "user", text: t }]);
    setInput("");

    // A pending field (asked for an address/date last turn).
    if (awaiting === "address") { setAddress(t); setAwaiting(null); return void say(`Done. Delivery address updated to "${t}". The carrier will reroute (demo).`); }
    if (awaiting === "date") { const d = parseDate(t); setEtaText(d); setAwaiting(null); return void say(`Done. Delivery is now scheduled for ${d} (demo).`); }

    const lc = t.toLowerCase();
    if (/\b(cancel|refund|don'?t want it|call it off)\b/.test(lc)) {
      if (cancelled) return void say("This order is already cancelled.");
      setCancelled(true);
      return void say(`Your order has been cancelled${amountDisplay ? ` and a refund of ${amountDisplay} would be issued` : ""} (demo). Nothing was really charged.`);
    }
    if (cancelled) return void say("This order was cancelled, so there is nothing to change. Head back to Aisle to shop again.");
    if (/\b(address|deliver to|ship to|send to|reroute|re-?route)\b/.test(lc)) {
      const m = t.match(/(?:to|address(?:\s+to)?|at)\s+(.+)$/i);
      const addr = m?.[1]?.trim();
      if (addr && addr.length > 4) { setAddress(addr); return void say(`Done. Delivery address updated to "${addr}" (demo).`); }
      setAwaiting("address");
      return void say("Sure. What is the new delivery address?");
    }
    if (/\b(date|resched|deliver on|change.*(day|date|time)|earlier|later|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lc)) {
      const m = t.match(/(?:to|on|for)\s+(.+)$/i);
      if (m?.[1]) { const d = parseDate(m[1]); setEtaText(d); return void say(`Done. Delivery rescheduled to ${d} (demo).`); }
      if (/tomorrow|next week|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday/.test(lc)) { const d = parseDate(t); setEtaText(d); return void say(`Done. Delivery rescheduled to ${d} (demo).`); }
      setAwaiting("date");
      return void say("Sure. What date works? For example: tomorrow, next Friday, or Sep 25.");
    }
    if (/\b(status|how'?s|how is|where('?s| is)?|track|update|going|when|arrive|eta|progress)\b/.test(lc)) {
      return void say(delivered ? `This order was delivered. Carrier ${carrier}, tracking ${tracking}.` : `It is ${statusLabel.toLowerCase()}. ${etaDisplay}. Carrier ${carrier}, tracking ${tracking}.`);
    }

    // Everything else: ask the model, with order context.
    setBusy(true);
    try {
      const res = await fetch("/api/order-chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: t,
          order: { item: q.item, status: statusLabel, eta: etaDisplay, address, carrier, tracking, amount: amountDisplay },
          history: msgs.slice(-8).map((mm) => ({ role: mm.role === "user" ? "user" : "assistant", content: mm.text })),
        }),
      });
      const data = await res.json() as { reply?: string };
      say(data.reply || "I can help with status, cancelling, or changing the address or date.");
    } catch {
      say("I could not reach the order assistant just now. Try 'how's it going', 'cancel', 'change address', or 'change date'.");
    } finally { setBusy(false); }
  };

  return (
    <>
      <Aurora />
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, position: "relative", zIndex: 1 }}>
        <div className="card card-pad" style={{ width: "min(580px, 100%)", display: "flex", flexDirection: "column", gap: 4, boxShadow: "0 24px 80px rgba(0,0,0,.35)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: "var(--muted)", fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase" }}>Order tracking</div>
              <div style={{ fontWeight: 660, fontSize: 20, letterSpacing: "-0.01em", marginTop: 2, color: cancelled ? "var(--warn)" : "var(--text)" }}>{statusLabel}</div>
            </div>
            <a className="btn btn-ghost btn-sm" href="/"><ArrowLeft size={15} /> Back to Aisle</a>
          </div>

          <div style={{ color: "var(--text-2)", fontSize: 14, marginTop: 6 }}>{q.item}</div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", color: "var(--muted)", fontSize: 12.5, marginTop: 6 }}>
            <span>Order <span className="mono" style={{ color: "var(--text-2)" }}>{id}</span></span>
            {amountDisplay ? <span>Total <span className="mono" style={{ color: "var(--text-2)" }}>{amountDisplay}</span></span> : null}
            <span>{etaDisplay}</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--muted)", fontSize: 12.5, marginTop: 4 }}>
            <MapPin size={13} weight="fill" style={{ color: "var(--accent)" }} /> Delivering to <span style={{ color: "var(--text-2)" }}>{address}</span>
          </div>

          <div style={{ height: 1, background: "var(--border)", margin: "16px 0 6px" }} />

          <div style={{ opacity: cancelled ? 0.4 : 1, transition: "opacity 200ms" }}>
            {STEPS.map((s, i) => {
              const done = !cancelled && i < current, active = !cancelled && i === current;
              const color = done || active ? "var(--accent)" : "var(--muted)";
              return (
                <div key={s.label} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", alignSelf: "stretch" }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", display: "grid", placeItems: "center", flex: "none", background: done ? "color-mix(in srgb, var(--accent) 18%, transparent)" : "var(--surface-3)", color, border: active ? "1px solid var(--accent)" : "1px solid transparent" }}>
                      <s.Icon size={17} weight={done ? "fill" : "bold"} />
                    </div>
                    {i < STEPS.length - 1 ? <div style={{ width: 2, flex: 1, minHeight: 24, background: !cancelled && i < current ? "var(--accent)" : "var(--border)", opacity: !cancelled && i < current ? 0.5 : 1 }} /> : null}
                  </div>
                  <div style={{ paddingBottom: 16, flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                      <span style={{ fontWeight: 560, color: done || active ? "var(--text)" : "var(--muted)" }}>{s.label}{active ? <span className="pulse" style={{ marginLeft: 8, display: "inline-block", verticalAlign: "middle" }} /> : null}</span>
                      <span className="mono" style={{ color: "var(--muted)", fontSize: 12.5 }}>{!cancelled && i <= current ? stepDate(i) : "—"}</span>
                    </div>
                    <div style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 2 }}>{s.sub}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {cancelled ? (
            <div className="tag" style={{ alignSelf: "flex-start", color: "var(--warn)", borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)", marginBottom: 8 }}><XCircle size={14} weight="fill" /> Order cancelled</div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px" }}>
              <div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>{carrier}</div>
                <div className="mono" style={{ fontSize: 14 }}>{tracking}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(tracking).catch(() => {})}><Copy size={14} /> Copy</button>
            </div>
          )}

          <div style={{ height: 1, background: "var(--border)", margin: "14px 0 10px" }} />

          {/* Manage-this-order chat */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 12.5, marginBottom: 8 }}>
            <ChatCircleDots size={15} weight="bold" style={{ color: "var(--accent)" }} /> Manage this order
          </div>
          <div ref={scRef} style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 4 }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{ maxWidth: "82%", fontSize: 13.5, lineHeight: 1.5, ...(m.role === "user"
                  ? { background: "var(--surface-2)", border: "1px solid var(--border)", padding: "8px 12px", borderRadius: "12px 12px 4px 12px", color: "var(--text)" }
                  : { color: "var(--text)" }) }}>{m.text}</div>
              </div>
            ))}
            {busy ? <div className="typing" style={{ padding: "4px 2px" }}><i /><i /><i /></div> : null}
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0 10px" }}>
            {QUICK.map((s) => <button key={s} className="suggest" disabled={busy} onClick={() => void send(s)}>{s}</button>)}
          </div>
          <div className="composer-box">
            <input
              className="composer-input"
              style={{ padding: "6px 0" }}
              placeholder="Ask about this order, or tell me a change…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void send(input); } }}
            />
            <button className="send" onClick={() => void send(input)} disabled={!input.trim() || busy} aria-label="Send"><PaperPlaneRight size={17} weight="fill" /></button>
          </div>

          <div className="tag" style={{ marginTop: 12, alignSelf: "center", color: "var(--warn)", borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)" }}>
            Demo tracking. No real order or shipment.
          </div>
        </div>
      </div>
    </>
  );
}
