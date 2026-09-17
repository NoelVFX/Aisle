/** The one-time sign-in page served at /login/:provider by the approval server. */
export function loginPage(provider: string): string {
  const safe = provider.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);
  const enc = encodeURIComponent(provider);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${safe} · Aisle</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.55 system-ui,sans-serif;max-width:34rem;margin:8vh auto;padding:0 1.25rem;color:#111}
  @media(prefers-color-scheme:dark){body{background:#0b0f14;color:#e6edf3}}
  h1{font-size:1.4rem;margin:0 0 .35rem}
  .muted{opacity:.72}
  button{font:inherit;font-weight:600;padding:.6rem 1rem;border-radius:.6rem;border:1px solid #8884;background:transparent;color:inherit;cursor:pointer}
  button[disabled]{opacity:.45;cursor:default}
  .card{margin:1.25rem 0;padding:1.1rem 1.15rem;border:1px solid #8883;border-radius:.8rem}
  .ok{color:#2ea043}
  .spin{display:inline-block;width:1rem;height:1rem;border:2px solid #8886;border-top-color:#c6f24e;border-radius:50%;animation:s .8s linear infinite;vertical-align:-2px}
  @keyframes s{to{transform:rotate(360deg)}}
  .big{font-size:2.4rem}
</style></head><body>
<h1>Connect ${safe}</h1>
<p class="muted">Authorize Aisle to act on your behalf on <b>${safe}</b>. Sign in once in the window that opens — Aisle remembers it in a private local profile and never asks again. Your password is typed into ${safe}'s own page, never seen by Aisle.</p>

<div class="card" id="working">
  <div><span class="spin"></span> <b id="s">Opening a secure sign-in window…</b></div>
  <p class="muted" style="margin:.6rem 0 0">Log in there (and dismiss any prompts). This page updates itself the moment you're signed in — you don't need to click anything.</p>
  <div style="margin-top:.8rem"><button id="done" disabled>I've signed in (only if it doesn't detect automatically)</button></div>
  <div id="err" class="muted" style="margin-top:.5rem"></div>
</div>

<div class="card" id="success" hidden>
  <div class="big">✅</div>
  <h1 class="ok">You're connected</h1>
  <p class="muted">Aisle saved your ${safe} sign-in. You can close this tab and the sign-in window, and return to the agent — it will keep going on its own.</p>
</div>

<script>
const P=${JSON.stringify(enc)};
const post=(a)=>fetch("/api/login/"+P+"/"+a,{method:"POST"}).then(r=>r.json());
const get=(a)=>fetch("/api/login/"+P+"/"+a).then(r=>r.json());
const $=(id)=>document.getElementById(id);
let finished=false;
function showSuccess(){ if(finished) return; finished=true; $("working").hidden=true; $("success").hidden=false; }
(async()=>{
  try{ const v=await post("start"); if(v.loggedIn){showSuccess();return;} $("s").textContent="Sign-in window is open — log in there."; $("done").disabled=false; }
  catch(e){ $("s").textContent="Couldn't open a sign-in window."; $("err").textContent=String(e); }
})();
// Poll for auto-detected completion.
const poll=setInterval(async()=>{ try{ const v=await get("status"); if(v.loggedIn){ clearInterval(poll); showSuccess(); } }catch{} }, 2000);
// Manual fallback.
$("done").addEventListener("click", async()=>{ $("done").disabled=true; try{ await post("finish"); }catch{} });
</script></body></html>`;
}
