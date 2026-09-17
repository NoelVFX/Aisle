/**
 * The in-chat recovery widget (MCP Apps, SEP-1865 / spec 2026-01-26).
 *
 * Visual agents (Claude, ChatGPT) render this next to a vendor tool call: the live
 * Steel browser doing the top-up, the recovery status and the timeline. It polls
 * `aisle__recovery_status` from the moment it renders, so the user can watch while
 * the original call is still blocked.
 *
 * It never approves. The one human tap stays on Aisle's own page (/browse): a tool
 * the widget could call is a tool the model could call.
 */

export const RECOVERY_WIDGET_URI = "ui://aisle/recovery.html";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** Steel's live viewer is an iframe inside the widget's sandbox. */
export const RECOVERY_WIDGET_CSP = {
  frameDomains: ["https://api.steel.dev", "https://app.steel.dev"],
  resourceDomains: ["https://api.steel.dev", "https://app.steel.dev"],
  connectDomains: [] as string[],
};

export const RECOVERY_WIDGET_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aisle recovery</title>
<style>
:root{--bg:#fff;--fg:#1c1c1a;--muted:#6b6a66;--line:#e0ded8;--accent:#1f4fd8;--ok:#1f7a4d;--no:#a3322b;--live:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#1f1e1b;--fg:#ecebe6;--muted:#9c9a92;--line:#33322d;--accent:#7aa2ff;--ok:#4fbf86;--no:#e0736b;--live:#fb923c}}
*{box-sizing:border-box}body{margin:0;padding:12px;font:13px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;margin-bottom:8px}header strong{font-size:14px}
#status{color:var(--muted)}#status.live{color:var(--live);font-weight:600}#status.ok{color:var(--ok)}#status.no{color:var(--no)}
.viewer{position:relative;width:100%;aspect-ratio:16/10;background:#000;border-radius:8px;overflow:hidden;border:1px solid var(--line)}
.viewer iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.empty{position:absolute;inset:0;display:grid;place-items:center;color:#aaa;padding:16px;text-align:center}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--accent);color:#fff;cursor:pointer}
#quote{margin:4px 0 8px}ol{margin:0;padding-left:18px;max-height:140px;overflow:auto;font:11px/1.5 ui-monospace,monospace;color:var(--muted)}
</style></head><body>
<header><strong>Aisle</strong><span id="status">Watching for a billing wall…</span></header>
<div id="quote"></div>
<div class="viewer" id="viewer"><div class="empty" id="empty">No top-up running.</div></div>
<div class="row"><button id="open">Open Aisle dashboard</button></div>
<ol id="events"></ol>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var nextId = 1, pending = {}, recoveryId = null, dashboard = "http://127.0.0.1:8797/browse", shownSrc = null, lastHeight = 0;

  function send(msg){ window.parent.postMessage(msg, "*"); }
  function rpc(method, params){
    if (method === "tools/call" && window.openai && window.openai.callTool) return window.openai.callTool(params.name, params.arguments);
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params });
    return new Promise(function(resolve, reject){
      pending[id] = { resolve: resolve, reject: reject };
      setTimeout(function(){ if (pending[id]) { delete pending[id]; reject(new Error("timeout")); } }, 15000);
    });
  }
  function parse(result){
    if (!result) return null;
    if (result.structuredContent) return result.structuredContent;
    var t = (result.content || []).filter(function(c){ return c.type === "text"; })[0];
    try { return t ? JSON.parse(t.text) : null; } catch (e) { return null; }
  }
  function adopt(r){
    if (!r) return;
    if (r.recovery_id) recoveryId = r.recovery_id;
    if (r.approve_url) dashboard = r.approve_url;
  }

  window.addEventListener("message", function(ev){
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && pending[m.id]) { var p = pending[m.id]; delete pending[m.id]; m.error ? p.reject(m.error) : p.resolve(m.result); return; }
    if (m.method === "ui/notifications/tool-result") { adopt(parse(m.params)); poll(); }
  });

  var LABELS = {
    awaiting_approval: ["Billing wall hit. Approve the top-up in the Aisle dashboard.", "live"],
    running: ["Aisle is topping up in the Steel browser…", "live"],
    resolved: ["Top-up verified. The original call was replayed.", "ok"],
    refused: ["Refused by policy. Nothing was bought.", "no"],
    rejected: ["You declined the purchase.", "no"],
    failed: ["Top-up failed.", "no"],
    staged_not_submitted: ["Checkout staged; real-money submit is off for this vendor.", "no"],
    dry_run_complete: ["Opened the billing page; nothing was bought.", "no"]
  };

  function render(s){
    if (!s || s.status === "NO_RECOVERY") return;
    adopt(s);
    var label = LABELS[s.status] || [s.status, ""];
    var text = label[0];
    if (s.live && s.live.interactive) text = s.live.takeover_reason === "LOGIN_REQUIRED" ? "Aisle needs you: sign in inside the Steel browser." : "Aisle needs you: clear the verification in the Steel browser.";
    if (s.error) text += " " + s.error;
    if (s.refusal) text += " " + s.refusal;
    $("status").textContent = (s.vendor ? s.vendor + " · " : "") + text;
    $("status").className = label[1];
    $("quote").textContent = s.quote ? s.quote.reason + (s.cap ? " Approved up to $" + s.cap + "." : "") : "";

    var src = s.live && s.live.debug_url ? s.live.debug_url : null;
    if (src !== shownSrc) {
      shownSrc = src;
      var v = $("viewer");
      Array.prototype.forEach.call(v.querySelectorAll("iframe"), function(f){ f.remove(); });
      $("empty").hidden = !!src;
      if (src) { var f = document.createElement("iframe"); f.src = src; f.allow = "clipboard-read; clipboard-write"; v.prepend(f); }
    }
    if (!src) $("empty").textContent = s.status === "awaiting_approval" ? "The Steel browser opens here after you approve." : s.status === "running" ? "Starting the Steel browser…" : "The Steel session has ended.";

    var ol = $("events"); ol.replaceChildren();
    (s.events || []).forEach(function(e){ var li = document.createElement("li"); li.textContent = e.at.slice(11, 19) + "  " + e.type; ol.append(li); });

    var h = document.documentElement.scrollHeight;
    if (h !== lastHeight) { lastHeight = h; send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: h } }); }
  }

  function poll(){
    rpc("tools/call", { name: "aisle__recovery_status", arguments: recoveryId ? { recovery_id: recoveryId } : {} })
      .then(function(r){ render(parse(r)); }, function(){});
  }

  $("open").onclick = function(){ rpc("ui/open-link", { url: dashboard }).catch(function(){ window.open(dashboard, "_blank", "noopener"); }); };

  rpc("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "aisle-recovery", version: "1.0.0" }, appCapabilities: {} })
    .then(function(){ send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }); }, function(){})
    .then(function(){ poll(); setInterval(poll, 1500); });
})();
</script></body></html>`;
