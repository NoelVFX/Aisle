/**
 * Local approval surface (aisle-pipeline.md §12): one URL per recovery.
 *
 *   GET  /r/{id}           approval card + live Steel browser + timeline (one page)
 *   GET  /r/{id}/state     JSON the page polls
 *   POST /r/{id}/approve   { mandate_signature }  → 204
 *   POST /r/{id}/reject    { reason? }            → 204
 *   POST /r/{id}/release   end the held Steel session → 204
 *
 * Every field on the card is a field in the mandate. Bound to 127.0.0.1 only.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { RecoveryCoordinator, RecoveryJob } from "./recovery.js";

export interface ApprovalServer {
  url: string;
  close(): Promise<void>;
}

function view(job: RecoveryJob) {
  const m = job.mandate;
  return {
    id: job.id,
    status: job.status,
    blocked_tool: job.checkpoint.tool,
    blocker: job.checkpoint.blocker.type,
    billing_origin: job.checkpoint.origin.billingOrigin,
    quote: job.quote && { reason: job.quote.reason, price: job.quote.price, units: job.quote.unitsGranted, product: job.quote.productId },
    mandate: m && {
      product: m.productId,
      units: m.unitsGranted,
      cap: m.maximumAmount,
      currency: m.currency,
      billing: m.billingType,
      auto_renew: m.autoRenew,
      billing_origin: m.billingOrigin,
      expires_at: m.expiresAt,
      signature: m.signature,
    },
    remaining: job.remaining,
    session: job.session.status,
    plans: job.plans,
    selected_plan: job.selectedPlanId,
    refusal: job.refusal && { reason: job.refusal.reason, message: job.refusal.message },
    lane: job.lane,
    live: job.live,
    steel: job.steel,
    staged: job.staged,
    purchase: job.purchase,
    error: job.error,
    events: job.events,
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aisle approval</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d1d1b;--muted:#6b6a66;--card:#fff;--line:#e2e0da;--ok:#1f7a4d;--no:#a3322b;--live:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eceae4;--muted:#9a988f;--card:#20201d;--line:#34332e;--ok:#4fbf86;--no:#e0736b;--live:#fb923c}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:1300px;margin:0 auto;display:grid;gap:16px;grid-template-columns:minmax(0,360px) minmax(0,1fr)}
@media (max-width:860px){main{grid-template-columns:1fr}}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;min-width:0}
h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:12px 0}dt{color:var(--muted)}dd{margin:0;word-break:break-word}
.amount{font-size:32px;font-weight:650}.status{color:var(--muted)}
button,.btn{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid var(--line);cursor:pointer;margin:0 8px 8px 0;display:inline-block;text-decoration:none;color:inherit;background:transparent}
#approve{background:var(--ok);color:#fff;border-color:transparent}#reject{color:var(--no)}
.livebadge{color:var(--live);font-weight:600}
ol{margin:0;padding-left:18px;max-height:280px;overflow:auto;font:12px/1.5 ui-monospace,monospace}
.frame{width:100%;aspect-ratio:16/9;max-width:100%;border:1px solid var(--line);border-radius:8px;background:#000;display:block}
.note{color:var(--muted);font-size:13px}
</style></head><body><main>
<section><h2>Approve this transaction</h2><h1 id="tool"></h1><div class="status" id="status"></div>
<div class="amount" id="amount"></div><div id="reason" class="note"></div>
<dl id="fields"></dl>
<div id="plans"></div>
<div id="actions"><button id="approve">Approve</button><button id="reject">Reject</button></div>
<p class="note">No real money moves in this gateway. After approval a Steel browser opens the vendor's billing page; mock vendors are credited in-process.</p>
</section>
<section><h2>Steel browser</h2><div id="viewer" class="note">Opens after approval.</div>
<h2 style="margin-top:16px">Timeline</h2><ol id="timeline"></ol></section>
</main>
<script>
const id = location.pathname.split("/")[2];
const $ = (s) => document.getElementById(s);
let signature = null, shown = null;
function row(k, v){ const dt=document.createElement("dt"); dt.textContent=k; const dd=document.createElement("dd"); dd.textContent=v; $("fields").append(dt, dd); }
function link(href, label){ const a=document.createElement("a"); a.href=href; a.target="_blank"; a.rel="noopener"; a.className="btn"; a.textContent=label; return a; }
function renderViewer(s){
  const key = s.live ? "live:"+s.live.sessionId : s.steel ? "done:"+s.steel.sessionId : null;
  if (key === shown) return; shown = key;
  const v = $("viewer"); v.replaceChildren();
  if (s.live){
    const p=document.createElement("p"); p.innerHTML='<span class="livebadge">● Live</span> '; p.append(document.createTextNode("Steel session "+s.live.sessionId)); v.append(p);
    if (s.live.debugUrl){ const f=document.createElement("iframe"); f.className="frame"; f.src=s.live.debugUrl; f.allow="clipboard-read; clipboard-write"; v.append(f); v.append(link(s.live.debugUrl, "Open Steel browser in a new tab")); }
    if (s.live.viewerUrl) v.append(link(s.live.viewerUrl, "Steel dashboard"));
    const b=document.createElement("button"); b.textContent="End Steel session"; b.onclick=async()=>{ await fetch("/r/"+id+"/release",{method:"POST"}); }; v.append(b);
  } else if (s.steel){
    const p=document.createElement("p"); p.textContent="Session "+s.steel.sessionId+" released. It opened "+s.steel.finalUrl+(s.steel.title?" · "+s.steel.title:""); v.append(p);
    if (s.steel.viewerUrl) v.append(link(s.steel.viewerUrl, "Replay in Steel dashboard"));
  }
}
async function refresh(){
  const r = await fetch("/r/"+id+"/state"); if(!r.ok){ $("status").textContent="Unknown recovery"; return; }
  const s = await r.json();
  $("tool").textContent = s.blocked_tool + " hit " + s.blocker;
  $("status").textContent = "Status: " + s.status + (s.session ? " · session " + s.session : "") + (s.refusal ? " · " + s.refusal.message : "") + (s.error ? " · " + s.error : "");
  $("plans").replaceChildren();
  if (s.plans && s.status === "awaiting_approval") {
    const all = [s.plans.recommended].concat(s.plans.alternatives);
    $("plans").append(Object.assign(document.createElement("p"), { className: "note", textContent: "Choose a plan:" }));
    all.forEach(function (p) {
      const label = document.createElement("label");
      const radio = Object.assign(document.createElement("input"), { type: "radio", name: "plan", checked: p.id === s.selected_plan });
      radio.onchange = async function () { await fetch("/r/" + id + "/select", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan_id: p.id }) }); refresh(); };
      label.append(radio, " " + p.name + " · " + p.credits + " units · $" + p.price + (p.id === s.plans.recommended.id ? " (recommended)" : ""));
      $("plans").append(label, document.createElement("br"));
    });
  }
  $("fields").replaceChildren();
  if (s.mandate){
    signature = s.mandate.signature;
    $("amount").textContent = "Up to $" + s.mandate.cap.toFixed(2);
    $("reason").textContent = s.quote ? s.quote.reason : "";
    row("Product", s.mandate.product); row("Units", String(s.mandate.units));
    row("Billing", s.mandate.billing); row("Auto-renew", s.mandate.auto_renew ? "on" : "off");
    row("Billing origin", s.mandate.billing_origin); row("Expires", new Date(s.mandate.expires_at).toLocaleTimeString());
    if (s.remaining){ row("Task ceiling left", "$"+s.remaining.task); row("Daily ceiling left", "$"+s.remaining.day); }
  }
  $("actions").hidden = s.status !== "awaiting_approval";
  renderViewer(s);
  $("timeline").replaceChildren(...s.events.map(e => { const li=document.createElement("li"); li.textContent=e.at.slice(11,19)+"  "+e.type+"  "+JSON.stringify(e.detail); return li; }));
}
$("approve").onclick = async () => { await fetch("/r/"+id+"/approve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mandate_signature:signature})}); refresh(); };
$("reject").onclick = async () => { await fetch("/r/"+id+"/reject",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}); refresh(); };
refresh(); setInterval(refresh, 1000);
</script></body></html>`;

/** Extra routes mounted on the same local server (the web product). Return true when handled. */
export type ExtraRoutes = (req: IncomingMessage, res: import("node:http").ServerResponse, url: URL) => Promise<boolean>;

export function startApprovalServer(coordinator: RecoveryCoordinator, port: number, attempts = 10, extra?: ExtraRoutes): Promise<ApprovalServer> {
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    const send = (status: number, body?: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
    };

    if (extra) {
      try {
        if (await extra(req, res, url)) return;
      } catch (err) {
        return send(500, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "GET" && parts.length === 0) {
      return send(200, coordinator.list().map((j) => ({ id: j.id, status: j.status, tool: j.checkpoint.tool, url: `/r/${j.id}` })));
    }
    if (parts[0] !== "r" || !parts[1]) return send(404, { error: "NOT_FOUND" });
    const job = coordinator.get(parts[1]);
    if (!job) return send(404, { error: "UNKNOWN_RECOVERY" });

    if (req.method === "GET" && parts.length === 2) return send(200, PAGE, "text/html; charset=utf-8");
    if (req.method === "GET" && parts[2] === "state") return send(200, view(job));
    if (req.method === "POST" && parts[2] === "approve") {
      const body = await readJson(req);
      const out = await coordinator.approve(job.id, String(body["mandate_signature"] ?? ""));
      return out.ok ? send(204) : send(409, out);
    }
    if (req.method === "POST" && parts[2] === "select") {
      const body = await readJson(req);
      const out = await coordinator.selectPlan(job.id, String(body["plan_id"] ?? ""));
      return out.ok ? send(200, { ok: true, selected_plan: job.selectedPlanId }) : send(409, out);
    }
    if (req.method === "POST" && parts[2] === "reject") {
      const body = await readJson(req);
      const out = coordinator.reject(job.id, typeof body["reason"] === "string" ? body["reason"] : undefined);
      return out.ok ? send(204) : send(409, { error: "NOT_AWAITING_APPROVAL" });
    }
    if (req.method === "POST" && parts[2] === "release") {
      return coordinator.releaseSteel(job.id) ? send(204) : send(409, { error: "NO_LIVE_STEEL_SESSION" });
    }
    return send(405, { error: "METHOD_NOT_ALLOWED" });
  });

  return new Promise((resolve, reject) => {
    let current = port;
    const tryListen = () => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && current < port + attempts) {
          current += 1;
          tryListen();
        } else reject(err);
      });
      server.listen(current, "127.0.0.1", () =>
        resolve({
          url: `http://127.0.0.1:${current}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        }),
      );
    };
    tryListen();
  });
}
