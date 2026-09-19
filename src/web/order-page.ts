export function orderPage(orderId: string): string {
  const safeId = JSON.stringify(orderId);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aisle order tracking</title>
<style>body{font:16px system-ui,sans-serif;background:#102c26;color:#f2f7ee;max-width:760px;margin:0 auto;padding:32px}h1{font-size:24px}.card{background:#173b32;border:1px solid #356050;border-radius:16px;padding:20px}.muted{color:#a9c4b3}.timeline{display:grid;gap:12px;margin-top:20px}.event{display:flex;gap:14px;align-items:flex-start}.dot{width:12px;height:12px;border-radius:50%;background:#c8f34a;margin-top:5px;flex:none}.status{font-weight:700}.meta{font-size:13px;color:#a9c4b3;margin-top:3px}a{color:#c8f34a}</style></head>
<body><h1>Aisle order tracking</h1><div id="app" class="card">Loading order…</div>
<script>
const orderId=${safeId};
const labels={PENDING:'Order created',CONFIRMED:'Order confirmed',PROCESSING:'Processing',SHIPPED:'Shipped',IN_TRANSIT:'In transit',OUT_FOR_DELIVERY:'Out for delivery',DELIVERED:'Delivered',CANCELLED:'Cancelled',EXCEPTION:'Exception'};
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){const r=await fetch('/api/orders/'+encodeURIComponent(orderId)+'/events');if(!r.ok){document.querySelector('#app').textContent='Order not found';return}const d=await r.json();const o=d.order;document.querySelector('#app').innerHTML='<div class="status">'+esc(labels[o.status]||o.status)+'</div><p>'+esc(o.vendor)+' · '+esc(o.currency)+' '+esc(o.amount)+'</p>'+(o.trackingNumber?'<p>Tracking: '+esc(o.carrier||'Carrier')+' · <a href="'+esc(o.trackingUrl||'#')+'" target="_blank" rel="noreferrer">'+esc(o.trackingNumber)+'</a></p>':'<p class="muted">Tracking information will appear when the merchant provides it.</p>')+'<div class="timeline">'+d.events.map(e=>'<div class="event"><span class="dot"></span><div><div class="status">'+esc(labels[e.status]||e.status)+'</div><div class="meta">'+esc(new Date(e.timestamp).toLocaleString())+' · '+esc(e.source)+'</div></div></div>').join('')+'</div>';}
load().catch(()=>document.querySelector('#app').textContent='Unable to load order');setInterval(load,60000);
</script></body></html>`;
}
