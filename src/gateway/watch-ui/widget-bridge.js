/*
 * The in-app widget: mounts the same AisleWatch renderer inside a GUI agent's
 * MCP Apps host (ui://aisle/watch-live.html). The host sends the tool input and
 * result over postMessage (JSON-RPC 2.0); the result's structuredContent.watch
 * says which recovery to show and how to reach the gateway.
 *
 * If the host sends only the tool input (a blocking aisle__wait_for_recovery),
 * the widget asks the gateway for the watch info itself by calling
 * aisle__watch_recovery through the host.
 */
(function () {
  "use strict";

  var PROTOCOL_VERSION = "2026-01-26";
  var root = document.getElementById("aisle-watch");
  var pending = {};
  var nextId = 1;
  var app = null;
  var mountedKey = null;
  var displayModes = [];
  var displayMode = "inline";

  function send(message) {
    window.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*");
  }

  function request(method, params) {
    var id = nextId++;
    send({ id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        reject(new Error(method + " timed out"));
      }, 15000);
    });
  }

  function notify(method, params) {
    send({ method: method, params: params || {} });
  }

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme === "dark" || ctx.theme === "light") document.documentElement.setAttribute("data-theme", ctx.theme);
    if (Array.isArray(ctx.availableDisplayModes)) displayModes = ctx.availableDisplayModes;
    if (ctx.displayMode) {
      displayMode = ctx.displayMode;
      if (app) app.setDisplayMode(displayMode);
    }
  }

  function watchFrom(result) {
    if (!result) return null;
    var sc = result.structuredContent || (result.result && result.result.structuredContent);
    if (sc && sc.watch && sc.watch.recovery_id && sc.watch.token) return sc.watch;
    // Hosts that drop structuredContent: read the watch URL out of the text.
    var content = result.content || (result.result && result.result.content) || [];
    for (var i = 0; i < content.length; i++) {
      var m = typeof content[i].text === "string" && content[i].text.match(/(https?:\/\/[^\s"]+)\/r\/([0-9a-f-]{36})\?t=([A-Za-z0-9_-]+)/);
      if (m) return { base_url: m[1], recovery_id: m[2], token: m[3] };
    }
    return null;
  }

  function show(watch) {
    var key = watch.recovery_id + "|" + watch.token;
    if (key === mountedKey) return;
    if (app) app.destroy();
    mountedKey = key;
    app = window.AisleWatch.mount(root, {
      id: watch.recovery_id,
      token: watch.token,
      base: watch.base_url,
      host: "widget",
      openLink: function (url) {
        request("ui/open-link", { url: url }).catch(function () { window.open(url, "_blank", "noopener"); });
      },
      hostFullscreen: {
        available: function () { return displayModes.indexOf("fullscreen") !== -1; },
        toggle: function () {
          return request("ui/request-display-mode", { mode: displayMode === "fullscreen" ? "inline" : "fullscreen" }).then(
            function (r) {
              displayMode = (r && r.mode) || displayMode;
              app.setDisplayMode(displayMode);
              return true;
            },
            function () { return false; });
        },
      },
    });
    app.setDisplayMode(displayMode);
  }

  function showIdle(text) {
    if (app) return;
    root.innerHTML = "";
    var p = document.createElement("p");
    p.className = "aw-idle";
    p.textContent = text;
    root.appendChild(p);
  }

  function onToolInput(params) {
    var id = params && params.arguments && params.arguments.recovery_id;
    if (!id || app) return;
    request("tools/call", { name: "aisle__watch_recovery", arguments: { recovery_id: String(id) } }).then(function (result) {
      var watch = watchFrom(result);
      if (watch) show(watch);
    }, function () {});
  }

  function onToolResult(result) {
    var watch = watchFrom(result);
    if (watch) show(watch);
    else showIdle("No live recovery to show for this call.");
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;

    if (msg.id !== undefined && !msg.method) {
      var p = pending[msg.id];
      if (!p) return;
      delete pending[msg.id];
      if (msg.error) p.reject(new Error(msg.error.message || "request failed"));
      else p.resolve(msg.result);
      return;
    }

    switch (msg.method) {
      case "ui/notifications/tool-input":
        return onToolInput(msg.params);
      case "ui/notifications/tool-result":
        return onToolResult(msg.params);
      case "ui/notifications/host-context-changed":
        return applyContext(msg.params);
      case "ui/resource-teardown":
        if (app) app.destroy();
        return send({ id: msg.id, result: {} });
      case "ping":
        return send({ id: msg.id, result: {} });
      default:
        if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
  });

  // Report our height so inline mode fits the content.
  var lastHeight = 0;
  new ResizeObserver(function () {
    var height = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    notify("ui/notifications/size-changed", { height: height });
  }).observe(document.documentElement);

  showIdle("Waiting for the recovery…");
  request("ui/initialize", {
    appInfo: { name: "aisle-watch-live", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion: PROTOCOL_VERSION,
  }).then(
    function (result) {
      applyContext(result && result.hostContext);
      notify("ui/notifications/initialized", {});
    },
    function () {
      // Not inside an MCP Apps host (e.g. opened directly). Nothing to bridge.
    });
})();
