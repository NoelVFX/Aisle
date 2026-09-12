/**
 * Watch-live demo. No Steel account or agent needed:   npm run demo:watch
 *
 * Opens one recovery on a scripted slow lane and prints the CLI line. Open it,
 * approve on the card, and watch a stand-in for Steel's live player walk the
 * checkout, hold still through a captcha pause, and hit a 3-D Secure challenge.
 * The viewer turns interactive: type any 6 digits, hand the browser back, and
 * the page swaps to the replay once the session is released.
 *
 *   --approve            approve automatically
 *   --port=8790          watch server port
 *   --fast               shorter pauses
 *   --replay=<sessionId> replay a real released Steel session (needs STEEL_API_KEY)
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEntitlement, makeResult, resolveRequirement } from "../core/outcome.js";
import { startApprovalServer } from "./approval-server.js";
import { RecoveryCoordinator, type SteelPurchaser } from "./recovery.js";
import { steelReplaySource, type ReplaySource } from "./replay.js";
import type { Upstreams } from "./upstreams.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) (process as unknown as { loadEnvFile(path: string): void }).loadEnvFile(ENV_FILE);

const flag = (name: string) => process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name: string) => flag(name)?.split("=")[1];
const fast = flag("fast") !== undefined;
const pace = (ms: number) => new Promise<void>((r) => setTimeout(r, fast ? ms / 3 : ms));

const BILLING = "https://demovendor.example";

// ---------------------------------------------------------------- stand-in player

type Step = "blank" | "account" | "pricing" | "checkout" | "captcha" | "3ds" | "done" | "closed";

const PLAYER_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;font:15px/1.45 system-ui,sans-serif;background:#fff;color:#1c1c1a;overflow:hidden}
.chrome{height:38px;display:flex;align-items:center;gap:10px;padding:0 12px;background:#e9e8e3;border-bottom:1px solid #d6d4cc;font-size:12.5px;color:#55544e}
.url{flex:1;background:#fff;border-radius:6px;padding:4px 10px;font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
main{padding:32px 44px}h1{margin:0 0 16px;font-size:26px}
.cards{display:flex;gap:16px}.c{border:1px solid #e2e0d8;border-radius:12px;padding:18px;flex:1}.c b{font-size:24px;display:block;margin-top:4px}.sel{outline:3px solid #2f4fc4}
.modal{position:absolute;inset:38px 0 0;background:rgba(20,20,18,.55);display:grid;place-items:center}
.box{background:#fff;border-radius:14px;padding:24px;width:min(380px,82%);box-shadow:0 20px 60px rgba(0,0,0,.35)}
input{font:inherit;font-size:22px;letter-spacing:.35em;width:100%;box-sizing:border-box;padding:8px 10px;margin:12px 0;border:1px solid #bbb;border-radius:8px}
button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#1c1c1a;color:#fff}button:disabled{opacity:.45}
.cursor{position:absolute;width:16px;height:16px;border-radius:50%;background:rgba(214,58,42,.9);box-shadow:0 0 0 7px rgba(214,58,42,.2);transition:left .9s,top .9s;pointer-events:none}
.spin{width:28px;height:28px;border:3px solid #ddd;border-top-color:#555;border-radius:50%}.dim{color:#77766f}
</style></head><body><div class="chrome"><span>&#9664; &#9654; &#10227;</span><div class="url" id="url"></div><span id="mode"></span></div>
<main id="page"></main><div class="cursor" id="cur" style="left:50%;top:50%"></div>
<script>
const interactive = new URLSearchParams(location.search).get("interactive") === "true";
document.getElementById("mode").textContent = interactive ? "interactive" : "view only";
const B = "${BILLING}";
const views = {
  blank: ["about:blank", '<p class="dim">Starting browser…</p>', [50, 50]],
  account: [B + "/account", '<h1>Account</h1><p>Signed in as demo@aisle.dev</p><p>Credit balance: <b>0</b> credits</p>', [30, 42]],
  pricing: [B + "/pricing", '<h1>Image credits</h1><div class="cards"><div class="c">1,000 credits<b>$5</b></div><div class="c sel">5,000 credits<b>$20</b></div></div>', [68, 58]],
  checkout: [B + "/checkout?p=c5000", '<h1>Checkout</h1><p>5,000 credits · <b>$20.00 USD</b> · one-time · auto-renew off</p><p>Card ending 4242</p><p><button>Complete purchase</button></p>', [16, 72]],
  captcha: [B + "/checkout?p=c5000", '<h1>Checkout</h1><p>5,000 credits · <b>$20.00 USD</b></p><div style="display:flex;gap:12px;align-items:center;margin-top:28px"><div class="spin"></div><span>Checking your browser before you continue…</span></div>', [16, 72]],
  done: [B + "/confirm", '<h1>Purchase complete</h1><p>Added 5,000 credits. Balance: <b>5,000</b> credits.</p>', [50, 50]],
  closed: ["about:blank", '<p class="dim">Session released.</p>', [50, 50]],
};
function threeDs(cleared) {
  if (cleared) return '<h1>Checkout</h1><div class="modal"><div class="box"><h2 style="margin:0 0 6px">Verified</h2><p>Your bank approved the payment. Hand the browser back to Aisle.</p></div></div>';
  const off = interactive ? "" : " disabled";
  return '<h1>Checkout</h1><div class="modal"><div class="box"><strong>Demo Bank · Secure checkout</strong><p>Enter the 6-digit code sent to your phone ending 42 to approve $20.00.</p>' +
    '<div><input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="••••••"' + off + '><button id="verify" type="button"' + off + '>Verify</button></div>' +
    '<p class="dim" style="font-size:12px">Demo: any 6 digits.</p></div></div>';
}
let shown = null;
async function poll() {
  try {
    const s = await (await fetch("/step", { cache: "no-store" })).json();
    const key = s.step + ":" + s.otpCleared;
    if (key !== shown) {
      shown = key;
      const v = s.step === "3ds" ? ["https://acs.demobank.example/3ds", threeDs(s.otpCleared), [50, 56]] : views[s.step] || views.blank;
      document.getElementById("url").textContent = v[0];
      document.getElementById("page").innerHTML = v[1];
      const cur = document.getElementById("cur");
      cur.style.left = v[2][0] + "%";
      cur.style.top = v[2][1] + "%";
      // A click handler, not a form: host sandboxes often omit allow-forms.
      const verify = document.getElementById("verify");
      if (verify) verify.onclick = async () => {
        if (/^\\d{6}$/.test(document.getElementById("code").value)) await fetch("/otp", { method: "POST" });
      };
    }
  } catch {}
  setTimeout(poll, 600);
}
poll();
</script></body></html>`;

function startPlayer(): Promise<{ url: string; state: { step: Step; otpCleared: boolean } }> {
  const state = { step: "blank" as Step, otpCleared: false };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://player.local");
    if (url.pathname === "/step") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return void res.end(JSON.stringify(state));
    }
    if (req.method === "POST" && url.pathname === "/otp" && state.step === "3ds") {
      state.otpCleared = true;
      res.writeHead(204);
      return void res.end();
    }
    if (url.pathname.startsWith("/player/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return void res.end(PLAYER_HTML);
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, state });
    }),
  );
}

// ---------------------------------------------------------------- scripted slow lane

const player = await startPlayer();
let releasedAt = 0;

const purchaser: SteelPurchaser = {
  async purchase({ job, emit, onLive, onTakeover }) {
    const sessionId = randomUUID();
    const viewerUrl = `https://app.steel.dev/sessions/${sessionId}`;
    player.state.step = "blank";
    player.state.otpCleared = false;

    await pace(1500);
    emit("STEEL_SESSION_CREATED", { sessionId, sessionViewerUrl: viewerUrl });
    onLive({ sessionId, debugUrl: `${player.url}/player/${sessionId}`, viewerUrl });
    try {
      await pace(1800);
      player.state.step = "account";
      emit("PAGE_OPENED", { url: `${BILLING}/account` });
      emit("PURCHASE_GUARDED");
      await pace(1200);
      emit("PROFILE_RESTORED", { provider: job.namespace, fromSavedProfile: true, dedicatedIp: false, loggedIn: true });
      emit("ENTITLEMENT_CHECKED", { balance: 0, required: 1067 });
      await pace(1800);
      player.state.step = "pricing";
      emit("OFFERS_DISCOVERED", { count: 2 });
      await pace(1400);
      emit("OFFER_SELECTED", { productId: "c5000", price: 20 });
      await pace(1800);
      player.state.step = "checkout";
      emit("CHECKOUT_STAGED", { lineItem: "5,000 credits", amount: 20, currency: "USD", billingPeriod: "one_time", autoRenew: false });
      await pace(1000);
      emit("MANDATE_COMPARISON_PASSED", { staged: 20, cap: job.mandate!.maximumAmount });
      emit("PURCHASE_SUBMITTED");

      // A captcha solve: the frame holds still and no events arrive for a while.
      // Not shortened by --fast: the page only calls out a pause after 20s.
      player.state.step = "captcha";
      await new Promise((r) => setTimeout(r, 24_000));

      player.state.step = "3ds";
      const reason = "Your bank wants a 3-D Secure code to approve the $20.00 charge.";
      emit("TAKEOVER_REQUESTED", { reason, sessionViewerUrl: viewerUrl });
      await onTakeover(reason);
      emit("TAKEOVER_RESOLVED");
      if (!player.state.otpCleared) {
        throw new Error("The 3-D Secure challenge wasn't completed and the balance didn't change. Nothing was charged.");
      }

      player.state.step = "done";
      await pace(1500);
      emit("PURCHASE_COMPLETED", { transactionId: `txn_${sessionId.slice(0, 8)}` });
      await pace(1200);
      emit("ENTITLEMENT_VERIFIED", { before: 0, after: 5000 });

      const request = { checkpoint: job.checkpoint, quote: job.quote!, mandate: job.mandate! };
      const now = new Date();
      return {
        outcome: "verified",
        result: makeResult({
          lane: "slow",
          purchaseId: `pur_${job.mandate!.mandateId}`,
          entitlement: makeEntitlement(job.mandate!, { balance: 5000, resource: "image_credits" }, now),
          request,
          requirement: resolveRequirement(request),
          alreadyCovered: false,
          now,
        }),
      };
    } finally {
      await pace(1500);
      player.state.step = "closed";
      releasedAt = Date.now();
      emit("SESSION_CLOSED", { sessionId });
    }
  },
};

const replaySessionId = flagValue("replay");
const steelKey = process.env["STEEL_API_KEY"];
const replay: ReplaySource =
  replaySessionId && steelKey
    ? { playlist: (_id) => steelReplaySource({ apiKey: steelKey }).playlist(replaySessionId) }
    : {
        // No recording in the demo: show "preparing", then "unavailable".
        playlist: async () =>
          Date.now() - releasedAt < 8000 ? { status: "processing" } : { status: "unavailable", reason: "DEMO_HAS_NO_RECORDING" },
      };

const upstreams: Upstreams = {
  demovendor: {
    description: "Scripted demo vendor.",
    canonicalOrigin: "https://api.demovendor.example",
    billingOrigin: BILLING,
    billingUrl: `${BILLING}/pricing`,
    resource: "image_credits",
    purchase: { mode: "slow-lane", realMoney: false },
    offers: [
      { productId: "c1000", label: "1,000 credits", unitsGranted: 1000, price: 5, currency: "USD", billing: "one_time", autoRenew: false },
      { productId: "c5000", label: "5,000 credits", unitsGranted: 5000, price: 20, currency: "USD", billing: "one_time", autoRenew: false },
    ],
  },
};

let baseUrl = "http://127.0.0.1";
const coordinator = new RecoveryCoordinator({
  upstreams,
  steel: {
    run: async () => {
      throw new Error("The demo only runs the slow lane.");
    },
  },
  fakeCredit: () => false,
  publicUrl: () => baseUrl,
  purchaser,
  mandateSecret: process.env["MANDATE_SECRET"] || "demo-only-secret",
});

const server = await startApprovalServer(coordinator, {
  port: Number(flagValue("port") ?? 8790),
  replay,
  frameOrigins: [player.url],
});
baseUrl = server.url;

const job = await coordinator.open({
  taskId: `task_demo_${randomUUID().slice(0, 8)}`,
  toolCallId: randomUUID(),
  namespace: "demovendor",
  tool: "demovendor__generate_image",
  arguments: { prompt: "hero image #1" },
  blocker: { type: "INSUFFICIENT_CREDITS", resource: "image_credits", required: 1067, confidence: "high", raw: { code: "insufficient_credits" } },
});

coordinator.subscribe(job.id, (_job, change) => {
  if (change) console.log(`  ${change.event.at.slice(11, 19)}  ${change.event.type}`);
});
console.log(`\n▶ Watch live: ${job.approveUrl}\n`);
if (flag("approve") !== undefined) await coordinator.approveMandate(job.id, job.mandate!.mandateId);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
