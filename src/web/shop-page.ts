/** The purchase-approval page served at /shop/:id by the approval server. */
export function shopPage(shopId: string, summary: string, totalLabel: string): string {
  const s = (x: string) => x.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);
  const enc = encodeURIComponent(shopId);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve purchase · Aisle</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.55 system-ui,sans-serif;max-width:32rem;margin:9vh auto;padding:0 1.25rem;color:#111}
  @media(prefers-color-scheme:dark){body{background:#0b0f14;color:#e6edf3}}
  h1{font-size:1.35rem;margin:0 0 .4rem}
  .muted{opacity:.72}
  .total{font-size:1.9rem;font-weight:700;margin:.2rem 0}
  .card{margin:1.1rem 0;padding:1.1rem 1.15rem;border:1px solid #8883;border-radius:.8rem}
  button{font:inherit;font-weight:700;padding:.7rem 1.15rem;border-radius:.6rem;border:0;background:#c6f24e;color:#0b0f14;cursor:pointer}
  button.secondary{background:transparent;border:1px solid #8884;color:inherit;font-weight:600}
  button[disabled]{opacity:.45;cursor:default}
  .ok{color:#2ea043}.big{font-size:2.4rem}
</style></head><body>
<h1>Approve this purchase</h1>
<p class="muted">Aisle will place this order on your behalf through Agnic's checkout engine, paying with your vaulted card. Nothing is charged until you approve.</p>
<div class="card" id="offer">
  <div class="total">${s(totalLabel)}</div>
  <p>${s(summary)}</p>
  <div style="display:flex;gap:.6rem;margin-top:.9rem">
    <button id="approve">Approve &amp; buy</button>
    <button class="secondary" id="cancel">Cancel</button>
  </div>
  <div id="err" class="muted" style="margin-top:.6rem"></div>
</div>
<div class="card" id="done" hidden>
  <div class="big">✅</div><h1 class="ok">Approved</h1>
  <p class="muted">Aisle is completing the purchase. You'll get a receipt in the agent — you can return to it now.</p>
</div>
<script>
const P=${JSON.stringify(enc)};
const $=(id)=>document.getElementById(id);
$("approve").addEventListener("click", async()=>{
  $("approve").disabled=true; $("cancel").disabled=true; $("err").textContent="";
  try{
    const r=await fetch("/api/shop/"+P+"/approve",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:"Approved via Aisle approval page"})});
    if(!r.ok){ throw new Error("HTTP "+r.status); }
    $("offer").hidden=true; $("done").hidden=false;
  }catch(e){ $("err").textContent="Couldn't record approval: "+e; $("approve").disabled=false; $("cancel").disabled=false; }
});
$("cancel").addEventListener("click", ()=>{ $("err").textContent="Cancelled — you can close this tab."; $("approve").disabled=true; });
</script></body></html>`;
}
