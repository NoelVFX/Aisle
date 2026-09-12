/**
 * Serving the watch UI. One renderer (`watch-ui/watch.js` + `watch.css`),
 * mounted twice:
 *
 *   - `renderWatchPage()`: the cloud page at /r/{id}, loading the assets from
 *     the gateway;
 *   - `renderWidgetHtml()`: the MCP Apps resource GUI agents embed, with the
 *     same assets inlined plus `widget-bridge.js`, which speaks the host's
 *     postMessage protocol and mounts the renderer.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** The widget's MCP resource. */
export const WATCH_WIDGET_URI = "ui://aisle/watch-live.html";
/** MCP Apps (SEP-1865) HTML resource type. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** Steel's live player, and the storage its replay segments are presigned on. */
const STEEL_PLAYER_ORIGIN = "https://api.steel.dev";
const STEEL_RECORDING_ORIGINS = ["https://fly.storage.tigris.dev"];

// Assets sit next to this file under src/; a tsc build in dist/ reads them from src/.
const UI_DIR = [new URL("./watch-ui/", import.meta.url), new URL("../../src/gateway/watch-ui/", import.meta.url)].find((dir) =>
  existsSync(fileURLToPath(new URL("watch.js", dir))),
);

const cache = new Map<string, string>();
function uiFile(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  if (!UI_DIR) throw new Error("watch-ui assets not found");
  const text = readFileSync(fileURLToPath(new URL(name, UI_DIR)), "utf8");
  if (process.env["AISLE_UI_DEV"] !== "1") cache.set(name, text);
  return text;
}

function hlsPath(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve("hls.js/dist/hls.min.js");
  } catch {
    return undefined;
  }
}

export function readAsset(name: string): { body: string | Buffer; type: string } | undefined {
  switch (name) {
    case "watch.js":
      return { body: uiFile("watch.js"), type: "text/javascript; charset=utf-8" };
    case "watch.css":
      return { body: uiFile("watch.css"), type: "text/css; charset=utf-8" };
    case "hls.min.js": {
      const path = hlsPath();
      return path ? { body: readFileSync(path), type: "text/javascript; charset=utf-8" } : undefined;
    }
    default:
      return undefined;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** Inline script/style text can't contain a closing tag. */
const inline = (s: string) => s.replace(/<\/(script|style)/gi, "<\\/$1");

const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">`;

/** The page shell. Carries no recovery data: it reads everything from the token-gated stream. */
export function renderWatchPage(): string {
  return `<!doctype html><html lang="en"><head>${HEAD}<title>Aisle · Watch live</title>
<link rel="stylesheet" href="/assets/watch.css"></head>
<body class="aw-page"><div id="aisle-watch"><noscript>This page needs JavaScript to show the live browser.</noscript></div>
<script src="/assets/watch.js" data-auto-mount></script></body></html>`;
}

export function renderMessagePage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head>${HEAD}<title>Aisle · ${escapeHtml(title)}</title>
<link rel="stylesheet" href="/assets/watch.css"></head>
<body class="aw-page"><div class="aw-root" data-host="page"><div class="aw aw-gone"><div class="aw-card">
<p class="aw-eyebrow">Aisle</p><h2 class="aw-headline">${escapeHtml(title)}</h2><p class="aw-detail">${escapeHtml(message)}</p>
</div></div></div></body></html>`;
}

/** CSP for the page: scripts and styles from the gateway only; frames from Steel's player. */
export function watchPageCsp(extraFrameOrigins: readonly string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `frame-src ${[STEEL_PLAYER_ORIGIN, ...extraFrameOrigins].join(" ")}`,
    `connect-src 'self' ${STEEL_RECORDING_ORIGINS.join(" ")}`,
    `media-src 'self' blob: ${STEEL_RECORDING_ORIGINS.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The widget: the same renderer inlined, plus the MCP Apps bridge. */
export function renderWidgetHtml(): string {
  return `<!doctype html><html lang="en"><head>${HEAD}<title>Aisle · Watch live</title>
<style>${inline(uiFile("watch.css"))}
.aw-idle{margin:0;padding:16px;color:#67665f;font:14px/1.45 system-ui,sans-serif}</style></head>
<body><div id="aisle-watch"></div>
<script>${inline(uiFile("watch.js"))}</script>
<script>${inline(uiFile("widget-bridge.js"))}</script></body></html>`;
}

/** `_meta.ui` for the widget resource: the host builds the sandbox CSP from it. */
export function widgetResourceMeta(publicUrl: string, extraFrameOrigins: readonly string[] = []) {
  const gateway = new URL(publicUrl).origin;
  return {
    ui: {
      csp: {
        connectDomains: [gateway, ...STEEL_RECORDING_ORIGINS],
        resourceDomains: [gateway, ...STEEL_RECORDING_ORIGINS],
        frameDomains: [STEEL_PLAYER_ORIGIN, ...extraFrameOrigins],
      },
      prefersBorder: true,
    },
  };
}
