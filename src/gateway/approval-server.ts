/**
 * The watch surface (aisle-pipeline.md §12): one URL per recovery. The CLI
 * prints it, a phone opens it, and the GUI widget renders the same projection.
 *
 *   GET  /r/{id}?t=…                page: live Steel viewer + timeline + approval / takeover
 *   GET  /r/{id}/events?t=…         text/event-stream: `timeline` (id = seq) and `state` (the projection)
 *   GET  /r/{id}/state?t=…          the same projection as JSON
 *   POST /r/{id}/approve?t=…        { mandate_id } (or { mandate_signature }) → 204
 *   POST /r/{id}/reject?t=…         { reason? } → 204
 *   POST /r/{id}/takeover/done?t=…  the human cleared a 3-DS/OTP challenge → 204
 *   POST /r/{id}/release?t=…        end a held viewing session → 204
 *   GET  /r/{id}/replay.m3u8?t=…    the released session's recording (the Steel key stays here)
 *   GET  /assets/{watch.js,watch.css,hls.min.js}
 *
 * Every /r/ route needs the job's access token: a missing or wrong one is a 404,
 * an expired link a 410. Nothing here talks to the browser; the page is a pure
 * projection, so closing and reopening it shows the current state.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RecoveryCoordinator, RecoveryJob } from "./recovery.js";
import type { ReplaySource } from "./replay.js";
import { DEFAULT_LINK_TTL_MS, linkExpired, tokenMatches } from "./watch-access.js";
import { projectEvent, projectJob, type ProjectOptions } from "./watch-view.js";
import { readAsset, renderMessagePage, renderWatchPage, watchPageCsp } from "./watch-ui.js";

export interface ApprovalServer {
  url: string;
  close(): Promise<void>;
}

export interface ApprovalServerOptions {
  port: number;
  /** Default 127.0.0.1. Reach it from elsewhere through AISLE_PUBLIC_URL or a tunnel. */
  host?: string;
  /** Try this many successive ports when one is taken. */
  attempts?: number;
  /** How long a finished recovery's link keeps working. */
  linkTtlMs?: number;
  replay?: ReplaySource;
  /** AISLE_STEEL_INTERACTIVE=1: the operator wants an interactive viewer outside takeovers. */
  viewerInteractive?: boolean;
  /** Extra origins the live viewer iframe may load (the demo's stand-in player). */
  frameOrigins?: string[];
  heartbeatMs?: number;
}

const CORS = {
  // The widget runs on a host sandbox origin. Auth is the token, never a cookie.
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, last-event-id",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "600",
};

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) return {};
    chunks.push(c as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body?: string | Buffer, type = "application/json", headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...CORS,
    ...headers,
  });
  res.end(body);
}

const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body));

export function startApprovalServer(
  coordinator: RecoveryCoordinator,
  portOrOptions: number | ApprovalServerOptions,
  attempts = 10,
): Promise<ApprovalServer> {
  const options: ApprovalServerOptions = typeof portOrOptions === "number" ? { port: portOrOptions, attempts } : portOrOptions;
  const linkTtlMs = options.linkTtlMs ?? DEFAULT_LINK_TTL_MS;
  const projectOptions: ProjectOptions = { linkTtlMs, viewerInteractive: options.viewerInteractive === true };
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const pageCsp = watchPageCsp(options.frameOrigins ?? []);
  const streams = new Set<() => void>();

  function streamEvents(req: IncomingMessage, res: ServerResponse, url: URL, job: RecoveryJob): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...CORS,
    });

    // EventSource resends the last id it saw on reconnect; a fresh page sends none.
    const header = req.headers["last-event-id"];
    const since = Number(typeof header === "string" && header !== "" ? header : (url.searchParams.get("since") ?? -1));
    const after = Number.isInteger(since) ? since : -1;

    let closed = false;
    let statePending = false;
    const write = (chunk: string) => {
      if (!closed) res.write(chunk);
    };
    const sendState = () => {
      statePending = false;
      if (closed) return;
      if (linkExpired(job, linkTtlMs)) {
        write("event: expired\ndata: {}\n\n");
        close();
        return;
      }
      write(`event: state\ndata: ${JSON.stringify(projectJob(job, projectOptions))}\n\n`);
    };
    const scheduleState = () => {
      if (statePending) return;
      statePending = true;
      setImmediate(sendState);
    };
    const heartbeat = setInterval(() => {
      write(": ping\n\n");
      if (job.finishedAt !== undefined && linkExpired(job, linkTtlMs)) scheduleState();
    }, heartbeatMs);
    heartbeat.unref?.();
    const unsubscribe = coordinator.subscribe(job.id, (_job, change) => {
      if (change) write(`id: ${change.seq}\nevent: timeline\ndata: ${JSON.stringify(projectEvent(change.seq, change.event))}\n\n`);
      scheduleState();
    });
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(close);
      res.end();
    }
    streams.add(close);
    req.on("close", close);

    write("retry: 2000\n\n");
    job.events.forEach((event, seq) => {
      if (seq > after) write(`id: ${seq}\nevent: timeline\ndata: ${JSON.stringify(projectEvent(seq, event))}\n\n`);
    });
    sendState();
  }

  async function sendReplay(res: ServerResponse, job: RecoveryJob): Promise<void> {
    if (!job.replay) return json(res, 404, { status: "unavailable", reason: job.live ? "SESSION_LIVE" : "NO_SESSION" });
    if (!options.replay) return json(res, 404, { status: "unavailable", reason: "REPLAY_NOT_CONFIGURED" });
    const playlist = await options.replay.playlist(job.replay.sessionId);
    if (playlist.status === "ready") return send(res, 200, playlist.body, "application/vnd.apple.mpegurl");
    if (playlist.status === "processing") return json(res, 202, { status: "processing" });
    return json(res, 404, { status: "unavailable", reason: playlist.reason });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return void res.end();
    }
    // No listing: recovery ids are not discoverable.
    if (req.method === "GET" && parts.length === 0) return json(res, 200, { service: "aisle-gateway", ok: true });
    if (req.method === "GET" && parts[0] === "assets" && parts.length === 2) {
      const asset = readAsset(parts[1]!);
      return asset
        ? send(res, 200, asset.body, asset.type, { "cache-control": "public, max-age=300" })
        : json(res, 404, { error: "NOT_FOUND" });
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204, { "cache-control": "public, max-age=86400" });
      return void res.end();
    }
    if (parts[0] !== "r" || !parts[1]) return json(res, 404, { error: "NOT_FOUND" });

    const isPage = req.method === "GET" && parts.length === 2;
    const job = coordinator.get(parts[1]);
    if (!job || !tokenMatches(job, url.searchParams.get("t"))) {
      return isPage
        ? send(res, 404, renderMessagePage("This link isn't valid", "Check that you copied the whole link, including everything after ?t=."), "text/html; charset=utf-8", { "content-security-policy": pageCsp })
        : json(res, 404, { error: "UNKNOWN_RECOVERY" });
    }
    if (linkExpired(job, linkTtlMs)) {
      return isPage
        ? send(res, 410, renderMessagePage("This link has expired", "Watch links stop working a while after the recovery finishes."), "text/html; charset=utf-8", { "content-security-policy": pageCsp })
        : json(res, 410, { error: "LINK_EXPIRED" });
    }

    switch (`${req.method} ${parts.slice(2).join("/")}`) {
      case "GET ":
        return send(res, 200, renderWatchPage(), "text/html; charset=utf-8", { "content-security-policy": pageCsp });
      case "GET state":
        return json(res, 200, projectJob(job, projectOptions));
      case "GET events":
        return streamEvents(req, res, url, job);
      case "GET replay.m3u8":
        return sendReplay(res, job);
      case "POST approve": {
        const body = await readJson(req);
        const out =
          typeof body["mandate_id"] === "string"
            ? await coordinator.approveMandate(job.id, body["mandate_id"])
            : await coordinator.approve(job.id, String(body["mandate_signature"] ?? ""));
        return out.ok ? send(res, 204) : json(res, 409, out);
      }
      case "POST reject": {
        const body = await readJson(req);
        const out = coordinator.reject(job.id, typeof body["reason"] === "string" ? body["reason"].slice(0, 500) : undefined);
        return out.ok ? send(res, 204) : json(res, 409, { error: "NOT_AWAITING_APPROVAL" });
      }
      case "POST takeover/done":
        return coordinator.completeTakeover(job.id) ? send(res, 204) : json(res, 409, { error: "NO_PENDING_TAKEOVER" });
      case "POST release":
        return coordinator.releaseSteel(job.id) ? send(res, 204) : json(res, 409, { error: "NO_LIVE_STEEL_SESSION" });
      default:
        return json(res, 405, { error: "METHOD_NOT_ALLOWED" });
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "INTERNAL" });
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    const host = options.host ?? "127.0.0.1";
    const maxPort = options.port + (options.attempts ?? 10);
    let current = options.port;
    const tryListen = () => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && options.port !== 0 && current < maxPort) {
          current += 1;
          tryListen();
        } else reject(err);
      });
      server.listen(current, host, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : current;
        resolve({
          url: `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`,
          close: () =>
            new Promise<void>((r) => {
              for (const close of [...streams]) close();
              server.close(() => r());
              server.closeAllConnections?.();
            }),
        });
      });
    };
    tryListen();
  });
}
