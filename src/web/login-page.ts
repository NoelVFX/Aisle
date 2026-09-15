/** The one-time sign-in page served at /login/:provider by the approval server. */
export function loginPage(provider: string): string {
  const safe = provider.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);
  const enc = encodeURIComponent(provider);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to ${safe} · Aisle</title>
<style>
  :root{color-scheme:light dark}
  body{font:15px/1.55 system-ui,sans-serif;max-width:34rem;margin:8vh auto;padding:0 1.25rem;color:#111}
  @media(prefers-color-scheme:dark){body{background:#0b0f14;color:#e6edf3}}
  h1{font-size:1.35rem;margin:0 0 .25rem}
  .muted{opacity:.7}
  button{font:inherit;font-weight:600;padding:.65rem 1.1rem;border-radius:.6rem;border:0;background:#c6f24e;color:#0b0f14;cursor:pointer}
  button[disabled]{opacity:.5;cursor:default}
  .step{margin:1.1rem 0;padding:1rem;border:1px solid #8883;border-radius:.7rem}
  .ok{color:#2ea043;font-weight:600}
  code{background:#8882;padding:.1rem .35rem;border-radius:.3rem}
</style></head><body>
<h1>Connect ${safe}</h1>
<p class="muted">Sign in once. Aisle remembers it in a private local browser profile and never asks again — your password is typed into ${safe}'s own page, never seen by Aisle.</p>
<div class="step" id="s1"><b>1.</b> A sign-in window is opening… <span id="s1status" class="muted">starting</span></div>
<div class="step"><b>2.</b> Log in there (and dismiss any prompts).</div>
<div class="step"><b>3.</b> Come back and click:
  <div style="margin-top:.7rem"><button id="done">I've signed in — save</button></div>
  <div id="result" style="margin-top:.7rem"></div>
</div>
<script>
const P=${JSON.stringify(enc)};
const api=(a)=>fetch("/api/login/"+P+"/"+a,{method:"POST"}).then(r=>r.json());
const s1=document.getElementById("s1status"), result=document.getElementById("result"), done=document.getElementById("done");
(async()=>{ try{ await api("start"); s1.textContent="opened — check the new window"; s1.className="ok"; }catch(e){ s1.textContent="couldn't open a window: "+e; } })();
done.addEventListener("click", async()=>{ done.disabled=true; result.textContent="Saving…"; try{ const v=await api("finish"); result.innerHTML = v.loggedIn ? '<span class="ok">Saved. You can close this tab and re-run your request.</span>' : 'Saved the session. If it still asks to log in, sign in again and retry.'; }catch(e){ result.textContent="Error: "+e; done.disabled=false; } });
</script></body></html>`;
}
