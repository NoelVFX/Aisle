"use client";

import { MagnifyingGlass, ShieldCheck, Storefront, Receipt, Lock, Lightning, GithubLogo } from "@phosphor-icons/react";

export default function Rail() {
  return (
    <aside className="rail">
      <div className="brand">
        <div className="brand-mark">A</div>
        <div>
          <div className="brand-name">Aisle</div>
          <div className="brand-sub">Agentic Checkout</div>
        </div>
      </div>

      <div>
        <div className="rail-title">How it works</div>
        <div className="rail-card">
          {[
            [<MagnifyingGlass key="i" size={16} weight="bold" />, "Discover", "Ranked, pitched, personal"],
            [<ShieldCheck key="i" size={16} weight="bold" />, "One approval", "You tap once. That is the mandate"],
            [<Storefront key="i" size={16} weight="bold" />, "Real checkout", "The merchant's own, vaulted card"],
            [<Receipt key="i" size={16} weight="bold" />, "Verified receipt", "Charge confirmed, then it ends"],
          ].map(([icon, title, sub], idx, arr) => (
            <div key={title as string} style={{ borderBottom: idx < arr.length - 1 ? "1px solid var(--border)" : "none", paddingBottom: idx < arr.length - 1 ? 4 : 0 }}>
              <div className="rail-row" style={{ paddingBottom: 2 }}>{icon}<span style={{ color: "var(--text)", fontWeight: 550 }}>{title}</span></div>
              <div style={{ color: "var(--muted)", fontSize: 12, paddingLeft: 26, paddingBottom: 4 }}>{sub as string}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="rail-title">Two rails</div>
        <div className="rail-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="rail-row" style={{ padding: 0 }}><Storefront size={16} weight="bold" /><span>Physical goods <span style={{ color: "var(--muted)" }}>&rarr; Agnic</span></span></div>
          <div className="rail-row" style={{ padding: 0 }}><Lightning size={16} weight="bold" /><span>Software and credits <span style={{ color: "var(--muted)" }}>&rarr; vendor checkout</span></span></div>
        </div>
      </div>

      <div>
        <div className="rail-title">Trust</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <span className="tag"><ShieldCheck size={13} weight="fill" /> Vaulted card</span>
          <span className="tag"><Lock size={13} weight="fill" /> Local profile</span>
          <span className="tag tag-accent">Never types your card</span>
        </div>
      </div>

      <a className="rail-row" style={{ marginTop: "auto", color: "var(--muted)", fontSize: 12.5 }} href="https://github.com/NoelVFX/Aisle" target="_blank" rel="noreferrer">
        <GithubLogo size={16} /> View the agent on GitHub
      </a>
    </aside>
  );
}
