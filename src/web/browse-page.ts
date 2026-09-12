/**
 * The web product (web-path.md §2.1, §6): Aisle chrome around a Steel viewer.
 *
 * The approval card renders HERE, in Aisle's own DOM, outside the iframe. Any
 * site in the iframe could draw a convincing fake card; this one it cannot touch.
 */

export const BROWSE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aisle Browser</title>
<style>
:root{--bg:#f4f3ef;--fg:#1c1c1a;--muted:#6b6a66;--card:#fff;--line:#e0ded8;--accent:#1f4fd8;--ok:#1f7a4d;--no:#a3322b;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--fg:#ecebe6;--muted:#9c9a92;--card:#1f1e1b;--line:#33322d;--accent:#7aa2ff;--ok:#4fbf86;--no:#e0736b;--warn:#f59e0b}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--card)}
header strong{font-size:16px;margin-right:8px}.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid var(--line);border-radius:999px;padding:3px 10px;display:inline-flex;gap:6px;align-items:center}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}.dot.on{background:var(--ok)}
.bar{display:flex;gap:8px;flex:1;min-width:260px}input{flex:1;font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);min-width:0}
button{font:inherit;padding:7px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);color:#fff;border-color:transparent}button.ok{background:var(--ok);color:#fff;border-color:transparent}button.no{color:var(--no)}
main{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px;padding:12px 16px}
@media (max-width:900px){main{grid-template-columns:1fr}}
.viewer{position:relative;min-width:0;background:#000;border-radius:10px;overflow:hidden;border:1px solid var(--line);aspect-ratio:1440/900;max-width:100%}
.viewer iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.viewer .empty{position:absolute;inset:0;display:grid;place-items:center;color:#aaa;text-align:center;padding:24px}
.freeze{position:absolute;inset:0;background:rgba(10,10,10,.55);display:grid;place-items:center;color:#fff;font-size:15px;text-align:center;padding:24px}
.freeze[hidden]{display:none}.label{position:absolute;left:10px;top:10px;background:rgba(0,0,0,.7);color:#fff;padding:3px 8px;border-radius:6px;font-size:12px}
aside{display:flex;flex-direction:column;gap:12px;min-width:0}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
h2{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.amount{font-size:26px;font-weight:650}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;margin:8px 0}dt{color:var(--muted)}dd{margin:0;word-break:break-word}
.toast{border-left:3px solid var(--warn);padding:6px 8px;margin-bottom:6px;background:var(--bg);border-radius:6px}
.toast.error{border-color:var(--no)}.toast.info{border-color:var(--ok)}
ol{margin:0;padding-left:16px;max-height:260px;overflow:auto;font:11px/1.5 ui-monospace,monospace}
.note{color:var(--muted);font-size:12px}
</style></head><body>
<header><strong>Aisle</strong><div class="chips" id="chips"></div>
<div class="bar"><input id="url" placeholder="https://…" aria-label="URL"><button id="go" class="primary">Start browsing</button><button id="stop">Stop</button></div></header>
<main>
<div class="viewer" id="viewer"><div class="empty" id="empty">Start browsing to open a Steel browser. Paywalls on connected vendors are handled by Aisle.</div>
<div class="label" id="label" hidden></div><div class="freeze" id="freeze" hidden></div></div>
<aside>
<section id="toastBox" hidden><h2>Notices</h2><div id="toasts"></div></section>
<section id="cardBox" hidden><h2>Approve this transaction</h2><div id="card"></div></section>
<section><h2>Timeline</h2><ol id="timeline"><li class="note">No recovery yet.</li></ol></section>
<p class="note">The approval card lives in Aisle's page, never inside the browser. Buying happens in a separate Steel session; if the vendor asks you to sign in, do it there.</p>
</aside></main>
<script>
const $ = (id) => document.getElementById(id);
let shownSrc = null, cardFor = null;
const post = (u, b) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) });
function el(tag, props, ...kids){ const e = document.createElement(tag); Object.assign(e, props || {}); kids.forEach(k => e.append(k)); return e; }

async function renderChips(){
  const r = await (await fetch("/api/enrollments")).json();
  $("chips").replaceChildren(...r.vendors.map(v => {
    const on = r.enrolled.includes(v.provider);
    const b = el("button", { textContent: on ? "Disconnect" : "Connect" });
    b.onclick = async () => { on ? await fetch("/api/enrollments/" + v.provider, { method: "DELETE" }) : await post("/api/enrollments", { provider: v.provider }); renderChips(); };
    return el("span", { className: "chip", title: v.billingOrigin }, el("span", { className: "dot" + (on ? " on" : "") }), v.provider, b);
  }));
}

function setViewer(src, label){
  if (src === shownSrc) return; shownSrc = src;
  const v = $("viewer"); v.querySelectorAll("iframe").forEach(f => f.remove());
  $("empty").hidden = !!src;
  if (src){ const f = el("iframe", { src, allow: "clipboard-read; clipboard-write" }); v.prepend(f); }
  $("label").hidden = !label; $("label").textContent = label || "";
}

async function renderCard(id){
  if (!id){ $("cardBox").hidden = true; cardFor = null; $("timeline").replaceChildren(el("li", { className: "note", textContent: "No recovery yet." })); return; }
  const s = await (await fetch("/r/" + id + "/state")).json();
  $("timeline").replaceChildren(...s.events.map(e => el("li", { textContent: e.at.slice(11,19) + "  " + e.type + "  " + JSON.stringify(e.detail) })));
  if (s.status !== "awaiting_approval" || !s.mandate){ $("cardBox").hidden = true; return; }
  $("cardBox").hidden = false;
  const cardKey = id + ":" + (s.selected_plan || ""); if (cardFor === cardKey) return; cardFor = cardKey;
  const m = s.mandate, dl = el("dl");
  [["Vendor", s.blocked_tool + " · " + s.blocker], ["Product", m.product], ["Units", String(m.units)], ["Billing", m.billing], ["Auto-renew", m.auto_renew ? "on" : "off"], ["Billing origin", m.billing_origin], ["Task ceiling left", s.remaining ? "$" + s.remaining.task : "-"], ["Daily ceiling left", s.remaining ? "$" + s.remaining.day : "-"]]
    .forEach(([k, v]) => dl.append(el("dt", { textContent: k }), el("dd", { textContent: v })));
  const ok = el("button", { className: "ok", textContent: "Approve" }); ok.onclick = () => post("/r/" + id + "/approve", { mandate_signature: m.signature });
  const no = el("button", { className: "no", textContent: "Reject" }); no.onclick = () => post("/r/" + id + "/reject");
  const plansBox = el("div");
  if (s.plans) {
    [s.plans.recommended].concat(s.plans.alternatives).forEach(p => {
      const r = el("input", { type: "radio", name: "plan", checked: p.id === s.selected_plan });
      r.onchange = () => post("/r/" + id + "/select", { plan_id: p.id });
      plansBox.append(el("label", {}, r, " " + p.name + " · $" + p.price + (p.id === s.plans.recommended.id ? " (recommended)" : "")), el("br"));
    });
  }
  $("card").replaceChildren(el("div", { className: "amount", textContent: "Up to $" + m.cap.toFixed(2) }), el("div", { className: "note", textContent: s.quote ? s.quote.reason : "" }), dl, plansBox, ok, " ", no);
}

// A CLI agent's recovery links here as /browse?recovery=<id>: follow that one.
const pinned = new URLSearchParams(location.search).get("recovery");
async function tick(){
  const s = await (await fetch("/api/browse/state" + (pinned ? "?recovery=" + encodeURIComponent(pinned) : ""))).json();
  $("empty").textContent = s.recoveryNote || "Start browsing to open a Steel browser. Paywalls on connected vendors are handled by Aisle.";
  if (s.workerDebugUrl) setViewer(s.workerDebugUrl, s.workerLabel || "Aisle is buying in a separate browser");
  else if (!s.active) setViewer(null, null);
  else setViewer(s.debugUrl + (s.debugUrl.includes("?") ? "&" : "?") + "interactive=true&showControls=true", null);
  $("freeze").hidden = !s.frozen || !!s.workerDebugUrl; $("freeze").textContent = s.frozenReason || "Paused";
  if (s.currentUrl && document.activeElement !== $("url")) $("url").value = s.currentUrl;
  $("toastBox").hidden = s.toasts.length === 0;
  $("toasts").replaceChildren(...s.toasts.map(t => {
    const d = el("div", { className: "toast " + t.kind, textContent: t.message });
    const x = el("button", { textContent: "Dismiss" }); x.onclick = () => post("/api/browse/toasts/" + t.id + "/dismiss"); d.append(" ", x);
    return d;
  }));
  await renderCard(s.recoveryId);
}
$("go").onclick = async () => { const url = $("url").value.trim(); const r = await post("/api/browse/start", url ? { url } : {}); if (!r.ok) alert((await r.json()).error); else if (url) post("/api/browse/navigate", { url }); };
$("stop").onclick = () => post("/api/browse/stop");
renderChips(); tick(); setInterval(tick, 1000);
</script></body></html>`;
