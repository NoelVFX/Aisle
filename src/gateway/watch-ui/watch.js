/*
 * Aisle watch UI: one renderer, two mounts.
 *
 *   - the cloud page at /r/{id}?t=… (auto-mounts from its own URL)
 *   - the in-app widget GUI agents render (widget-bridge.js calls AisleWatch.mount)
 *
 * It is a projection of GET /r/{id}/events and nothing else: `state` messages
 * carry the server's projection, `timeline` messages the event stream. It never
 * talks to the browser. The only things it can do are approve / reject the
 * mandate, hand a takeover back, and end a held viewing session, all through
 * the gateway's endpoints.
 */
(function () {
  "use strict";

  var PHASE_LABEL = {
    connecting: "Connecting",
    live: "Live",
    awaiting_approval: "Awaiting approval",
    takeover_requested: "Takeover requested",
    completed: "Completed",
    refused: "Refused",
    failed: "Failed",
  };

  var ERROR_TEXT = {
    MANDATE_ID_MISMATCH: "This approval card is out of date. Reload the page.",
    NO_PENDING_TAKEOVER: "There's no takeover waiting any more.",
    NOT_AWAITING_APPROVAL: "This purchase is no longer waiting for a decision.",
    NO_LIVE_STEEL_SESSION: "The session has already ended.",
    LINK_EXPIRED: "This link has expired.",
  };

  function h(tag, attrs) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") el.className = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) return child.forEach(function (c) { append(el, c); });
    el.append(child instanceof Node ? child : String(child));
  }

  function money(n, currency) {
    var c = currency || "USD";
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n);
    } catch (_) {
      return n.toFixed(2) + " " + c;
    }
  }

  var num = function (n) { return Number(n).toLocaleString(); };
  var clock = function (iso) { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };

  function countdown(ms) {
    if (ms <= 0) return "0:00";
    var s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function tone(type) {
    if (/FAILED|REFUSED|REJECTED|MISMATCH|UNKNOWN/.test(type)) return "bad";
    if (/TAKEOVER|WITHHELD/.test(type)) return "warn";
    if (/VERIFIED|COMPLETED|GRANTED|PASSED|RESOLVED|FINISHED|HANDED_BACK/.test(type)) return "good";
    return "plain";
  }

  function summary(detail) {
    var parts = [];
    Object.keys(detail || {}).forEach(function (k) {
      var v = detail[k];
      if (v === null || v === undefined || v === "") return;
      var s = typeof v === "object" ? JSON.stringify(v) : String(v);
      parts.push(k + "=" + (s.length > 64 ? s.slice(0, 63) + "…" : s));
    });
    var out = parts.join("  ");
    return out.length > 180 ? out.slice(0, 179) + "…" : out;
  }

  var hlsLoading = null;
  function loadHls(base) {
    if (window.Hls) return Promise.resolve();
    if (!hlsLoading) {
      hlsLoading = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = (base || "") + "/assets/hls.min.js";
        s.onload = function () { resolve(); };
        s.onerror = function () { hlsLoading = null; reject(new Error("hls.js failed to load")); };
        document.head.appendChild(s);
      });
    }
    return hlsLoading;
  }

  /**
   * opts: { id, token, base?: gateway origin ("" = same origin), host?: "page" | "widget",
   *         openLink?(url), hostFullscreen?: { available(): boolean, toggle(): Promise<boolean> } }
   */
  function mount(root, opts) {
    var base = (opts.base || "").replace(/\/+$/, "");
    var host = opts.host || "page";
    var view = null;
    var maxSeq = -1;
    var es = null;
    var destroyed = false;
    var everOpen = false;
    var lostAt = 0;
    var backoff = 0;
    var retryTimer = 0;
    var viewerKey = null;
    var hls = null;
    var replayTimer = 0;
    var replayTries = 0;
    var hiddenAt = 0;
    var lastActivity = Date.now();
    var busy = null;
    var cardError = null;
    var bannerKey = null;
    var expanded = false;
    var hostMode = "inline";

    function api(path, params) {
      var u = new URL(base + "/r/" + encodeURIComponent(opts.id) + path, location.href);
      u.searchParams.set("t", opts.token);
      Object.keys(params || {}).forEach(function (k) { u.searchParams.set(k, params[k]); });
      return u.toString();
    }

    function link(url, label) {
      return h("a", {
        class: "aw-link",
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
        onclick: opts.openLink ? function (e) { e.preventDefault(); opts.openLink(url); } : null,
      }, label);
    }

    var el = {};
    root.classList.add("aw-root");
    root.setAttribute("data-host", host);
    var shell = h("div", { class: "aw", "data-phase": "connecting" },
      h("header", { class: "aw-head" },
        h("div", { class: "aw-title" },
          h("span", { class: "aw-brand" }, "Aisle"),
          (el.tool = h("span", { class: "aw-tool" }, "Loading recovery…"))),
        h("div", { class: "aw-status" },
          (el.conn = h("span", { class: "aw-conn", hidden: true }, "Reconnecting…")),
          (el.pill = h("span", { class: "aw-pill" }, h("i", { "aria-hidden": "true" }), (el.pillText = h("span", {}, "Connecting")))))),
      h("div", { class: "aw-body" },
        (el.stage = h("section", { class: "aw-stage", "aria-label": "Browser Aisle is driving" },
          (el.banner = h("div", { class: "aw-banner", hidden: true })),
          (el.screen = h("div", { class: "aw-screen" })),
          h("div", { class: "aw-bar" },
            (el.session = h("span", { class: "aw-session" })),
            (el.quiet = h("span", { class: "aw-quiet", hidden: true })),
            h("span", { class: "aw-spacer" }),
            (el.reconnect = h("button", { class: "aw-btn aw-small", type: "button", hidden: true, onclick: function () { remountViewer(); } }, "Reconnect viewer")),
            (el.fs = h("button", { class: "aw-btn aw-small", type: "button", "aria-pressed": "false", onclick: toggleFullscreen }, "Fullscreen"))))),
        h("aside", { class: "aw-side" },
          (el.card = h("section", { class: "aw-card", "aria-live": "polite" })),
          h("section", { class: "aw-timeline" },
            h("h3", {}, "Timeline"),
            (el.list = h("ol", {}))))));
    root.replaceChildren(shell);
    el.screen.append(placeholder("Connecting to the recovery…", null, null, true));
    el.card.append(h("p", { class: "aw-eyebrow" }, "Connecting"), h("p", { class: "aw-detail" }, "Fetching the current state."));

    function placeholder(title, sub, extra, spinning) {
      return h("div", { class: "aw-empty" },
        spinning ? h("span", { class: "aw-spinner", "aria-hidden": "true" }) : null,
        h("strong", {}, title),
        sub ? h("span", {}, sub) : null,
        extra || null);
    }

    // ---------------------------------------------------------------- state

    function applyState(v) {
      view = v;
      lastActivity = Date.now();
      shell.setAttribute("data-phase", v.phase);
      el.pillText.textContent = PHASE_LABEL[v.phase] || v.phase;
      el.tool.textContent = v.blocked_tool + " hit " + v.blocker.replace(/_/g, " ").toLowerCase();
      renderViewer(v);
      renderBanner(v);
      renderCard(v);
      tick();
    }

    function renderViewer(v) {
      var vw = v.viewer;
      var key = vw.mode === "live" ? "live|" + vw.session_id + "|" + (vw.embed_url || "") : vw.mode === "replay" ? "replay|" + vw.session_id : "none|" + v.phase;
      el.session.textContent = vw.mode === "none" ? "" : (vw.mode === "live" ? "Steel session " : "Replay of session ") + vw.session_id.slice(0, 8);
      el.reconnect.hidden = vw.mode !== "live";
      el.stage.classList.toggle("aw-interactive", vw.mode === "live" && vw.interactive);
      if (key === viewerKey) return;
      viewerKey = key;
      teardownMedia();
      if (vw.mode === "live") return mountLive(vw);
      if (vw.mode === "replay") return mountReplay(vw);
      el.screen.replaceChildren(idlePlaceholder(v));
    }

    function idlePlaceholder(v) {
      switch (v.phase) {
        case "awaiting_approval":
          return placeholder("The browser opens after you approve", "You'll watch every step Aisle takes on " + v.billing_origin + ".");
        case "connecting":
          return placeholder("Starting a browser…", "Steel is opening a session on " + v.billing_origin + ".", null, true);
        case "refused":
        case "failed":
          return placeholder("No browser session to show", v.outcome.detail);
        default:
          return placeholder("No browser session for this recovery", null);
      }
    }

    function mountLive(vw) {
      if (!vw.embed_url) {
        el.screen.replaceChildren(placeholder("Live view unavailable", "Steel returned no player for this session.", vw.dashboard_url && link(vw.dashboard_url, "Open in the Steel dashboard")));
        return;
      }
      var frame = h("iframe", {
        class: "aw-frame",
        src: vw.embed_url,
        title: vw.interactive ? "Steel browser, interactive" : "Steel browser, view only",
        allow: "autoplay; fullscreen; clipboard-read; clipboard-write",
        referrerpolicy: "no-referrer",
        tabindex: vw.interactive ? null : "-1",
      });
      el.screen.replaceChildren(
        frame,
        // Read-only means read-only here too, whatever the player allows.
        vw.interactive ? null : h("div", { class: "aw-shield", "aria-hidden": "true" }),
        h("span", { class: "aw-tag" + (vw.interactive ? " aw-tag-warn" : "") }, h("i", { "aria-hidden": "true" }), vw.interactive ? "Interactive" : "Live · view only"));
    }

    function remountViewer() {
      if (!view || view.viewer.mode !== "live") return;
      viewerKey = null;
      renderViewer(view);
    }

    function dashboardLink(vw) {
      return vw.dashboard_url ? link(vw.dashboard_url, "Open in the Steel dashboard (Steel login)") : null;
    }

    function mountReplay(vw) {
      replayTries = 0;
      loadReplay(vw);
    }

    function stillShowing(vw) {
      return !destroyed && viewerKey === "replay|" + vw.session_id;
    }

    function loadReplay(vw) {
      var url = api("/replay.m3u8");
      fetch(url, { cache: "no-store" })
        .then(function (r) { return r.status; }, function () { return 0; })
        .then(function (status) {
          if (!stillShowing(vw)) return;
          if (status === 200) return playReplay(url, vw);
          if ((status === 202 || status === 0) && replayTries++ < 36) {
            el.screen.replaceChildren(placeholder("Preparing the replay…", "The session was released. Steel is finishing the recording.", dashboardLink(vw), true));
            replayTimer = setTimeout(function () { loadReplay(vw); }, 5000);
            return;
          }
          el.screen.replaceChildren(placeholder("Replay unavailable", "The recording for this session couldn't be loaded.", dashboardLink(vw)));
        });
    }

    // hls.js (Media Source Extensions) first: desktop Chrome now claims native HLS
    // but doesn't play Steel's fMP4 playlists. Native playback covers browsers
    // without MSE (older iPhone Safari) and is the fallback when hls.js fails.
    function playReplay(url, vw) {
      var video = h("video", { class: "aw-video", controls: true, playsinline: true, muted: true, preload: "metadata" });
      var nativeOk = !!video.canPlayType("application/vnd.apple.mpegurl");
      var show = function () {
        el.screen.replaceChildren(video, h("span", { class: "aw-tag aw-tag-replay" }, "Replay"));
      };
      var unavailable = function () {
        if (!stillShowing(vw)) return;
        teardownMedia();
        el.screen.replaceChildren(placeholder("Replay unavailable", "The recording couldn't be played.", dashboardLink(vw)));
      };
      var playNative = function () {
        teardownMedia();
        video.onerror = unavailable;
        video.src = url;
        show();
      };
      loadHls(base).then(null, function () {}).then(function () {
        if (!stillShowing(vw)) return;
        if (!window.Hls || !window.Hls.isSupported()) {
          if (nativeOk) return playNative();
          el.screen.replaceChildren(placeholder("This browser can't play the replay", null, dashboardLink(vw)));
          return;
        }
        hls = new window.Hls({ enableWorker: host === "page" });
        var retried = false;
        hls.on(window.Hls.Events.ERROR, function (_e, data) {
          if (!data || !data.fatal) return;
          if (!retried && data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            retried = true;
            hls.startLoad();
            return;
          }
          if (nativeOk) playNative();
          else unavailable();
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        show();
      });
    }

    function teardownMedia() {
      clearTimeout(replayTimer);
      if (hls) {
        hls.destroy();
        hls = null;
      }
    }

    function renderBanner(v) {
      var key = v.phase === "takeover_requested" && v.takeover ? v.takeover.requested_at : null;
      if (key === bannerKey) return;
      bannerKey = key;
      if (!key) {
        el.banner.hidden = true;
        el.banner.replaceChildren();
        el.takeoverClock = null;
        return;
      }
      el.banner.hidden = false;
      el.banner.replaceChildren(
        h("div", { class: "aw-banner-text" },
          h("strong", {}, "Your turn. "),
          v.takeover.reason,
          h("span", {}, " The browser below is interactive now: finish the verification there, then hand it back."),
          (el.takeoverClock = h("span", { class: "aw-clock" }))),
        (el.handBack = h("button", { class: "aw-btn aw-primary", type: "button", onclick: handBack }, "Done, hand back")));
    }

    function renderCard(v) {
      var c = [];
      if (v.phase === "awaiting_approval" && v.mandate) {
        var m = v.mandate;
        el.expiry = h("span", { class: "aw-num" });
        c.push(
          h("p", { class: "aw-eyebrow" }, "Approve this purchase"),
          h("div", { class: "aw-amount" }, h("small", {}, "Up to "), money(m.cap, m.currency)),
          v.quote ? h("p", { class: "aw-detail" }, v.quote.reason) : null,
          rows([
            ["Product", m.product],
            ["Units", num(m.units)],
            ["Billing", m.billing === "one_time" ? "One-time" : m.billing],
            ["Auto-renew", m.auto_renew ? "On" : "Off"],
            ["Billing origin", m.billing_origin],
            ["Decide within", el.expiry],
            v.remaining && ["Task ceiling left", money(v.remaining.task)],
            v.remaining && ["Daily ceiling left", money(v.remaining.day)],
          ]),
          h("div", { class: "aw-actions" },
            h("button", { class: "aw-btn aw-primary", type: "button", disabled: !!busy, onclick: function () { decide("approve"); } }, busy === "approve" ? "Approving…" : "Approve"),
            h("button", { class: "aw-btn aw-danger", type: "button", disabled: !!busy, onclick: function () { decide("reject"); } }, busy === "reject" ? "Rejecting…" : "Reject")),
          h("p", { class: "aw-fine" }, "Aisle buys exactly this on " + m.billing_origin + " and nothing else. The browser stays view-only unless a bank check needs you."));
      } else {
        c.push(
          h("p", { class: "aw-eyebrow" }, PHASE_LABEL[v.phase] || v.phase),
          h("h2", { class: "aw-headline" }, v.outcome.headline),
          v.outcome.detail ? h("p", { class: "aw-detail" }, v.outcome.detail) : null);
        if (v.mandate && (v.phase === "connecting" || v.phase === "live" || v.phase === "takeover_requested")) {
          c.push(rows([["Approved cap", money(v.mandate.cap, v.mandate.currency)], ["Product", v.mandate.product], ["Billing origin", v.mandate.billing_origin]]));
        }
        if (v.staged) c.push(rows([["Staged item", v.staged.line_item], ["Staged amount", money(v.staged.amount, v.staged.currency)]]));
        if (v.can_release) {
          c.push(h("div", { class: "aw-actions" }, h("button", { class: "aw-btn", type: "button", disabled: !!busy, onclick: release }, busy === "release" ? "Ending…" : "End session")));
        }
        if (v.link_expires_at) c.push(h("p", { class: "aw-fine" }, "This link stops working " + new Date(v.link_expires_at).toLocaleString() + "."));
      }
      if (cardError) c.push(h("p", { class: "aw-error", role: "alert" }, cardError));
      el.card.replaceChildren.apply(el.card, c.filter(Boolean));
    }

    function rows(list) {
      var dl = h("dl", { class: "aw-rows" });
      list.forEach(function (r) {
        if (r) dl.append(h("dt", {}, r[0]), h("dd", {}, r[1]));
      });
      return dl;
    }

    // ---------------------------------------------------------------- actions

    function post(path, body) {
      return fetch(api(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then(
        function (r) {
          if (r.ok) return null;
          return r.json().then(
            function (j) { return ERROR_TEXT[j.error] || (j.error ? String(j.error).replace(/_/g, " ").toLowerCase() : "Request failed (" + r.status + ")."); },
            function () { return "Request failed (" + r.status + ")."; });
        },
        function () { return "Couldn't reach Aisle. Check your connection and try again."; });
    }

    function decide(kind) {
      if (!view || !view.mandate || busy) return;
      busy = kind;
      cardError = null;
      renderCard(view);
      post("/" + kind, kind === "approve" ? { mandate_id: view.mandate.mandate_id } : {}).then(function (err) {
        busy = null;
        cardError = err;
        if (view) renderCard(view);
      });
    }

    function release() {
      busy = "release";
      cardError = null;
      renderCard(view);
      post("/release").then(function (err) {
        busy = null;
        cardError = err;
        if (view) renderCard(view);
      });
    }

    function handBack() {
      var btn = el.handBack;
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "Handing back…";
      post("/takeover/done").then(function (err) {
        if (!err || !btn.isConnected) return;
        btn.disabled = false;
        btn.textContent = "Done, hand back";
        el.banner.append(h("p", { class: "aw-error", role: "alert" }, err));
      });
    }

    // ---------------------------------------------------------------- timeline

    function addEvent(e) {
      if (e.seq <= maxSeq) return;
      maxSeq = e.seq;
      lastActivity = Date.now();
      var list = el.list;
      var stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
      var s = summary(e.detail);
      list.append(h("li", { class: "aw-ev aw-ev-" + tone(e.type) }, h("time", { datetime: e.at }, clock(e.at)), h("code", {}, e.type), s ? h("span", {}, s) : null));
      while (list.children.length > 400) list.firstChild.remove();
      if (stick) list.scrollTop = list.scrollHeight;
    }

    // ---------------------------------------------------------------- clocks

    function tick() {
      if (!view) return;
      var now = Date.now();
      if (el.expiry && view.mandate && el.expiry.isConnected) {
        var left = Date.parse(view.mandate.expires_at) - now;
        el.expiry.textContent = left > 0 ? countdown(left) : "Expired";
      }
      if (el.takeoverClock && view.takeover) {
        el.takeoverClock.textContent = " Hands back automatically in " + countdown(Date.parse(view.takeover.deadline) - now) + ".";
      }
      var quietFor = now - lastActivity;
      // A captcha solve or a slow page can hold the frame still for tens of
      // seconds. That's a pause, not a failure: say so calmly and keep going.
      if (view.phase === "live" && quietFor > 20000) {
        el.quiet.hidden = false;
        el.quiet.textContent = "No new steps for " + Math.round(quietFor / 1000) + "s. The page may be solving a captcha; the picture can hold still.";
      } else {
        el.quiet.hidden = true;
      }
    }
    var ticker = setInterval(tick, 1000);

    // ---------------------------------------------------------------- stream

    function setConnected(ok) {
      el.conn.hidden = ok || !everOpen;
      shell.classList.toggle("aw-offline", !ok && everOpen);
    }

    function connect() {
      if (destroyed) return;
      clearTimeout(retryTimer);
      es = new EventSource(api("/events", maxSeq >= 0 ? { since: String(maxSeq) } : {}));
      es.addEventListener("state", function (e) { applyState(JSON.parse(e.data)); });
      es.addEventListener("timeline", function (e) { addEvent(JSON.parse(e.data)); });
      es.addEventListener("expired", function () { gone("This link has expired", "Watch links stop working a while after the recovery finishes."); });
      es.onopen = function () {
        everOpen = true;
        backoff = 0;
        setConnected(true);
        if (lostAt) {
          // A network drop that long has almost certainly killed the WebRTC stream too.
          var long = Date.now() - lostAt > 3000;
          lostAt = 0;
          if (long) remountViewer();
        }
      };
      es.onerror = function () {
        if (destroyed) return;
        if (!lostAt) lostAt = Date.now();
        setConnected(false);
        if (es.readyState !== EventSource.CLOSED) return; // the browser is already retrying
        es.close();
        fetch(api("/state"), { cache: "no-store" }).then(
          function (r) {
            if (r.status === 404) return gone("This link isn't valid", "Check that you copied the whole link.");
            if (r.status === 410) return gone("This link has expired", "Watch links stop working a while after the recovery finishes.");
            retry();
          },
          retry);
      };
    }

    function retry() {
      if (destroyed) return;
      retryTimer = setTimeout(connect, Math.min(15000, 1000 * Math.pow(2, backoff++)));
    }

    function gone(title, sub) {
      destroy();
      root.replaceChildren(h("div", { class: "aw aw-gone" }, h("div", { class: "aw-card" }, h("p", { class: "aw-eyebrow" }, "Aisle"), h("h2", { class: "aw-headline" }, title), h("p", { class: "aw-detail" }, sub))));
    }

    // ---------------------------------------------------------------- fullscreen

    function isFullscreen() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement) || expanded || hostMode === "fullscreen";
    }

    function syncFullscreen() {
      var on = isFullscreen();
      el.fs.textContent = on ? "Exit fullscreen" : "Fullscreen";
      el.fs.setAttribute("aria-pressed", String(on));
    }

    function setExpanded(on) {
      expanded = on;
      shell.classList.toggle("aw-expanded", on);
      syncFullscreen();
    }

    function toggleFullscreen() {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        return;
      }
      if (expanded) return setExpanded(false);
      var hostFs = opts.hostFullscreen && opts.hostFullscreen.available() ? opts.hostFullscreen.toggle() : Promise.resolve(false);
      hostFs.then(function (handled) {
        if (handled) return;
        var target = el.stage;
        var req = target.requestFullscreen || target.webkitRequestFullscreen;
        if (!req) return setExpanded(true);
        try {
          Promise.resolve(req.call(target)).catch(function () { setExpanded(true); });
        } catch (_) {
          setExpanded(true);
        }
      }, function () { setExpanded(true); });
    }

    function onKey(e) {
      if (e.key === "Escape" && expanded) setExpanded(false);
    }

    // ---------------------------------------------------------------- resilience

    function onVisibility() {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      // Mobile browsers suspend WebRTC in background tabs.
      if (hiddenAt && Date.now() - hiddenAt > 15000) remountViewer();
      hiddenAt = 0;
    }

    function onOnline() {
      remountViewer();
      if (!es || es.readyState === EventSource.CLOSED) connect();
    }

    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("webkitfullscreenchange", syncFullscreen);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKey);
    window.addEventListener("online", onOnline);

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(ticker);
      clearTimeout(retryTimer);
      teardownMedia();
      if (es) es.close();
      document.removeEventListener("fullscreenchange", syncFullscreen);
      document.removeEventListener("webkitfullscreenchange", syncFullscreen);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("online", onOnline);
    }

    connect();

    return {
      destroy: destroy,
      getView: function () { return view; },
      /** The widget host moved the app between inline and fullscreen. */
      setDisplayMode: function (mode) {
        hostMode = mode;
        shell.classList.toggle("aw-host-fullscreen", mode === "fullscreen");
        syncFullscreen();
      },
    };
  }

  window.AisleWatch = { mount: mount, version: 1 };

  var script = document.currentScript;
  if (script && script.hasAttribute("data-auto-mount")) {
    var match = location.pathname.match(/\/r\/([^/]+)\/?$/);
    var token = new URLSearchParams(location.search).get("t");
    var root = document.getElementById("aisle-watch");
    if (match && token && root) mount(root, { id: decodeURIComponent(match[1]), token: token, host: "page" });
  }
})();
