"use client";

import { useState } from "react";
import {
  ShieldCheck, Sparkle, CheckCircle, PlusCircle, Lock, Storefront,
  Cardholder, Plugs, ArrowSquareOut, Compass,
} from "@phosphor-icons/react";
import type { AgentRequest, Block, Product, Tone } from "@/lib/types";
import { money, toneLabel } from "@/lib/demoData";

export type Sender = (payload: { text?: string; action?: AgentRequest["action"] }) => void;

function ToneTag({ tone }: { tone: Tone }) {
  return <span className={`tone tone-${tone}`}>{toneLabel(tone)}</span>;
}

function ProductCard({ p, send }: { p: Product; send: Sender }) {
  return (
    <button className="product" onClick={() => send({ action: { kind: "pick", sku: p.sku } })}>
      {/* Demo imagery from picsum; swap for real merchant photos when wired to a live gateway. */}
      <img className="product-img" src={p.image} alt={p.title} loading="lazy" />
      <div className="product-info">
        <div className="product-top">
          <span className="product-title">{p.title}</span>
          <span className="product-price mono">{money(p.priceMinor, p.currency)}</span>
        </div>
        <p className="pitch">{p.pitch}</p>
        <div className="product-foot">
          <ToneTag tone={p.tone} />
          {p.why ? <span className="tag" style={{ fontSize: 11 }}>{p.why}</span> : null}
        </div>
      </div>
    </button>
  );
}

function Shortlist({ heading, products, send }: { heading: string; products: Product[]; send: Sender }) {
  return (
    <div>
      <div className="comp-title"><Compass size={15} weight="bold" /> {heading}, ranked for you</div>
      <div className="grid grid-2 stagger">
        {products.map((p) => <ProductCard key={p.sku} p={p} send={send} />)}
      </div>
    </div>
  );
}

function Approval({ b, send }: { b: Extract<Block, { type: "approval" }>; send: Sender }) {
  const [done, setDone] = useState(false);
  const { product, totalMinor, currency, recurring, complements } = b;
  return (
    <div className="card">
      <div className="approve">
        <div className="approve-head">
          <img className="approve-thumb" src={product.image} alt="" />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 580, letterSpacing: "-0.01em" }}>{product.title}</div>
            <div style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 2 }}>
              <Storefront size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
              {product.merchantId.replace("m_", "")}
            </div>
          </div>
        </div>
        <div>
          <div className="approve-total mono">{money(totalMinor, currency)} {recurring ? <small>{recurring}</small> : null}</div>
        </div>
        <div className="mandate"><ShieldCheck size={15} weight="fill" style={{ color: "var(--accent)" }} /> Paid with your vaulted card. Aisle never sees the number.</div>
        {done ? (
          <div className="tag tag-accent" style={{ alignSelf: "flex-start" }}><CheckCircle size={14} weight="fill" /> Approved</div>
        ) : (
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" onClick={() => { setDone(true); send({ action: { kind: "approve", sku: product.sku } }); }}>
              <CheckCircle size={17} weight="fill" /> Approve and buy
            </button>
            <button className="btn btn-ghost" onClick={() => send({ text: "not now, show me something else" })}>Cancel</button>
          </div>
        )}
      </div>
      {complements.length > 0 && !done ? (
        <div style={{ borderTop: "1px solid var(--border)", padding: 16 }}>
          <div className="comp-title"><PlusCircle size={14} weight="bold" /> Frequently bought together</div>
          <div className="comp-row">
            {complements.map((c) => (
              <button key={c.sku} className="comp" onClick={() => send({ action: { kind: "pick", sku: c.sku } })}>
                <img src={c.image} alt={c.title} loading="lazy" />
                <div className="comp-info">
                  <div className="t">{c.title}</div>
                  <div className="p mono">{money(c.priceMinor, c.currency)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReceiptCard({ b }: { b: Extract<Block, { type: "receipt" }> }) {
  const r = b.receipt;
  return (
    <div className="card receipt">
      <div className="receipt-badge"><CheckCircle size={26} weight="fill" /></div>
      <div style={{ fontWeight: 600, fontSize: 16 }}>Purchase complete</div>
      <div style={{ color: "var(--muted)", fontSize: 13 }}>{r.item}</div>
      <div className="receipt-rows">
        {[
          ["Order", r.orderId],
          [r.demo ? "Amount" : "Charged", money(r.amountMinor, r.currency)],
          ["Merchant", r.merchantId.replace("m_", "")],
          ["Status", r.status],
        ].map(([k, v]) => (
          <div className="receipt-row" key={k}><span>{k}</span><span className="mono">{v}</span></div>
        ))}
      </div>
      {r.demo ? (
        <div className="tag" style={{ marginTop: 14, alignSelf: "center", color: "var(--warn)", borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)" }}>
          <Lock size={13} weight="fill" /> Simulated in demo mode. No real charge.
        </div>
      ) : null}
    </div>
  );
}

function ToolRecCard({ b, send }: { b: Extract<Block, { type: "toolRec" }>; send: Sender }) {
  const r = b.rec;
  const free = r.planPriceMinor === 0;
  return (
    <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="tool-head">
        <div className="tool-logo">{r.toolName[0]}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15.5 }}>{r.toolName}</div>
          <div style={{ color: "var(--muted)", fontSize: 12.5 }}>{r.category}</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {r.hasMcp ? <span className="tag tag-accent"><Plugs size={12} weight="bold" /> MCP</span> : null}
          <span className="tag">{r.plan} plan</span>
        </div>
      </div>
      <p className="pitch" style={{ fontSize: 13.5 }}>{r.why}</p>
      <div className="alt-row">
        <span style={{ color: "var(--muted)", fontSize: 12.5, marginRight: 2 }}>Also considered</span>
        {r.alternatives.map((a) => <span key={a.toolName} className="tag" title={a.why}>{a.toolName}</span>)}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 2 }}>
        {free ? (
          <a className="btn btn-ghost btn-sm" href={r.checkoutUrl} target="_blank" rel="noreferrer">
            Start free <ArrowSquareOut size={15} />
          </a>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={() => send({ action: { kind: "pick", sku: r.buySku } })}>
            <Cardholder size={16} weight="fill" /> Buy the {r.plan} plan
          </button>
        )}
        <a className="btn btn-ghost btn-sm" href={r.checkoutUrl} target="_blank" rel="noreferrer">Pricing <ArrowSquareOut size={14} /></a>
      </div>
    </div>
  );
}

const PERSONA = ["student", "budget-conscious", "smart-casual", "tech", "minimalist", "premium-seeker"];

function ProfileForm({ send }: { send: Sender }) {
  const [about, setAbout] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const toggle = (t: string) => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  return (
    <div className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="field">
        <label className="label" htmlFor="about">A little about you (optional)</label>
        <textarea id="about" className="textarea" placeholder="e.g. uni student on a budget, prefer smart-casual, into mechanical keyboards" value={about} onChange={(e) => setAbout(e.target.value)} />
      </div>
      <div className="field">
        <span className="label">Or tap what fits</span>
        <div className="chips">
          {PERSONA.map((t) => (
            <button key={t} className="chip" aria-pressed={tags.includes(t)} onClick={() => toggle(t)}>{t}</button>
          ))}
        </div>
      </div>
      <div className="consent-note"><Lock size={14} /> Stored on your device only. Never sent to a merchant. Used just to rank what I show you.</div>
      <div style={{ display: "flex", gap: 10 }}>
        <button
          className="btn btn-primary btn-sm"
          disabled={saved || (about.trim() === "" && tags.length === 0)}
          onClick={() => { setSaved(true); send({ action: { kind: "saveProfile", about, tags: tags.length ? tags : deriveTags(about) } }); }}
        >
          <ShieldCheck size={16} weight="fill" /> Save with consent
        </button>
        <button className="btn btn-ghost btn-sm" disabled={saved} onClick={() => send({ text: "skip the profile for now" })}>Skip</button>
      </div>
    </div>
  );
}

function deriveTags(about: string): string[] {
  const t = about.toLowerCase();
  const out: string[] = [];
  if (/student|uni|college/.test(t)) out.push("student");
  if (/budget|cheap|afford|frugal/.test(t)) out.push("budget-conscious");
  if (/smart.?casual|business|office/.test(t)) out.push("smart-casual");
  if (/tech|keyboard|developer|gadget/.test(t)) out.push("tech");
  if (/minimal|simple|clean/.test(t)) out.push("minimalist");
  if (/premium|luxury|high.?end/.test(t)) out.push("premium-seeker");
  return out.length ? out : ["smart-casual"];
}

function ProfileSaved({ tags }: { tags: string[] }) {
  return (
    <div className="tag tag-accent" style={{ alignSelf: "flex-start", padding: "8px 12px" }}>
      <ShieldCheck size={15} weight="fill" /> Profile saved{tags.length ? `: ${tags.join(", ")}` : ""}
    </div>
  );
}

function ForYouEmpty() {
  return (
    <div className="card empty">
      <div className="empty-mark"><Sparkle size={22} weight="fill" /></div>
      <h4>Your For You is empty, for now</h4>
      <p style={{ maxWidth: 320, margin: "0 auto" }}>Buy something and this fills with picks drawn from what you own. A first-time page stays blank on purpose. Nothing invented.</p>
    </div>
  );
}

export function BlockView({ block, send }: { block: Block; send: Sender }) {
  switch (block.type) {
    case "text": return <div className="prose" dangerouslySetInnerHTML={{ __html: mdBold(block.text) }} />;
    case "shortlist": return <Shortlist heading={block.heading} products={block.products} send={send} />;
    case "approval": return <Approval b={block} send={send} />;
    case "receipt": return <ReceiptCard b={block} />;
    case "toolRec": return <ToolRecCard b={block} send={send} />;
    case "profileForm": return <ProfileForm send={send} />;
    case "profileSaved": return <ProfileSaved tags={block.tags} />;
    case "forYouEmpty": return <ForYouEmpty />;
    default: return null;
  }
}

/** Minimal, safe **bold** rendering. Escapes HTML first, then applies bold spans. */
function mdBold(s: string): string {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

export function Shimmer() {
  return (
    <div className="grid grid-2" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="product" style={{ pointerEvents: "none" }}>
          <div className="skel" style={{ aspectRatio: "16 / 10", borderRadius: 0 }} />
          <div className="product-info">
            <div className="skel" style={{ height: 15, width: "70%" }} />
            <div className="skel" style={{ height: 12, width: "95%" }} />
            <div className="skel" style={{ height: 12, width: "40%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}
