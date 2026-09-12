import { afterEach, describe, expect, it } from "vitest";
import { get as httpGet } from "node:http";
import { makeEntitlement, makeResult, resolveRequirement } from "../src/core/outcome.js";
import { startApprovalServer, type ApprovalServer } from "../src/gateway/approval-server.js";
import { createGateway } from "../src/gateway/gateway.js";
import { RecoveryCoordinator, type RecoveryJob, type SteelPurchaser, type SteelRunner } from "../src/gateway/recovery.js";
import { steelReplaySource, type ReplayFetch, type ReplaySource } from "../src/gateway/replay.js";
import { loadUpstreams, MockImageVendor } from "../src/gateway/upstreams.js";
import { renderWidgetHtml, widgetResourceMeta } from "../src/gateway/watch-ui.js";
import { embedUrl, phaseOf, redactDetail } from "../src/gateway/watch-view.js";
import type { Blocker } from "../src/types.js";

const SECRET = "watch-secret";
const UPSTREAMS_FILE = new URL("../src/gateway/upstreams.json", import.meta.url);
/** mockvendor with its slow-lane purchase config switched on. */
const slowUpstreams = loadUpstreams(UPSTREAMS_FILE, { MOCK_VENDOR_PUBLIC_URL: "https://mock.example" });
const blocker: Blocker = { type: "INSUFFICIENT_CREDITS", resource: "image_credits", required: 1067, confidence: "high", raw: {} };
const noSteel: SteelRunner = {
  run: async () => {
    throw new Error("no Steel in this test");
  },
};

const PLAYER = "https://api.steel.dev/v1/sessions/sess_1/player";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A slow lane that goes live, asks for a takeover, and releases when told. */
function scriptedPurchaser() {
  const gates = { takeover: deferred(), release: deferred() };
  const purchaser: SteelPurchaser = {
    async purchase({ job, emit, onLive, onTakeover }) {
      emit("STEEL_SESSION_CREATED", { sessionId: "sess_1", debugUrl: PLAYER, sessionViewerUrl: "https://app.steel.dev/sessions/sess_1" });
      onLive({ sessionId: "sess_1", debugUrl: PLAYER, viewerUrl: "https://app.steel.dev/sessions/sess_1" });
      await gates.takeover.promise;
      emit("TAKEOVER_REQUESTED", { reason: "3-DS challenge" });
      await onTakeover("3-DS challenge");
      emit("TAKEOVER_RESOLVED");
      await gates.release.promise;
      emit("SESSION_CLOSED", { sessionId: "sess_1" });
      const request = { checkpoint: job.checkpoint, quote: job.quote!, mandate: job.mandate! };
      const now = new Date();
      return {
        outcome: "verified",
        result: makeResult({
          lane: "slow",
          purchaseId: "pur_1",
          entitlement: makeEntitlement(job.mandate!, { balance: 5000, resource: "image_credits" }, now),
          request,
          requirement: resolveRequirement(request),
          alreadyCovered: false,
          now,
        }),
      };
    },
  };
  return { purchaser, gates };
}

type Message = { event: string; id?: string; data: any };
const openStreams: Array<{ close(): void }> = [];
const servers: ApprovalServer[] = [];

afterEach(async () => {
  openStreams.splice(0).forEach((s) => s.close());
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A minimal EventSource over node:http. */
function sse(url: string, headers: Record<string, string> = {}) {
  const messages: Message[] = [];
  let listeners: Array<() => void> = [];
  let buffer = "";
  const req = httpGet(url, { headers }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const msg: Message = { event: "message", data: undefined };
        let data = "";
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const i = line.indexOf(":");
          const key = line.slice(0, i);
          const value = line.slice(i + 1).replace(/^ /, "");
          if (key === "event") msg.event = value;
          else if (key === "id") msg.id = value;
          else if (key === "data") data += value;
        }
        if (!data) continue;
        msg.data = JSON.parse(data);
        messages.push(msg);
        listeners.forEach((l) => l());
      }
    });
  });
  req.on("error", () => {});
  const stream = {
    states: () => messages.filter((m) => m.event === "state").map((m) => m.data),
    last: () => messages.filter((m) => m.event === "state").at(-1)?.data,
    timeline: () => messages.filter((m) => m.event === "timeline").map((m) => m.data),
    until: (predicate: () => boolean, ms = 2000) =>
      new Promise<void>((resolve, reject) => {
        if (predicate()) return resolve();
        const check = () => {
          if (!predicate()) return;
          clearTimeout(timer);
          listeners = listeners.filter((l) => l !== check);
          resolve();
        };
        const timer = setTimeout(() => {
          listeners = listeners.filter((l) => l !== check);
          reject(new Error("timed out waiting on the stream"));
        }, ms);
        listeners.push(check);
      }),
    close: () => req.destroy(),
  };
  openStreams.push(stream);
  return stream;
}

async function setup(opts: { purchaser?: SteelPurchaser; replay?: ReplaySource; linkTtlMs?: number; takeoverTimeoutMs?: number } = {}) {
  let base = "http://127.0.0.1:0";
  const coordinator = new RecoveryCoordinator({
    upstreams: slowUpstreams,
    steel: noSteel,
    fakeCredit: () => false,
    publicUrl: () => base,
    mandateSecret: SECRET,
    ...(opts.purchaser ? { purchaser: opts.purchaser } : {}),
    ...(opts.takeoverTimeoutMs ? { takeoverTimeoutMs: opts.takeoverTimeoutMs } : {}),
  });
  const server = await startApprovalServer(coordinator, {
    port: 0,
    heartbeatMs: 50,
    ...(opts.replay ? { replay: opts.replay } : {}),
    ...(opts.linkTtlMs !== undefined ? { linkTtlMs: opts.linkTtlMs } : {}),
  });
  servers.push(server);
  base = server.url;
  const job = await coordinator.open({
    taskId: "t",
    toolCallId: "c",
    namespace: "mockvendor",
    tool: "mockvendor__generate_image",
    arguments: { prompt: "x" },
    blocker,
  });
  const at = (path = "", token = job.accessToken) => `${server.url}/r/${job.id}${path}?t=${token}`;
  const post = (path: string, body: unknown = {}) =>
    fetch(at(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { coordinator, server, job, at, post };
}

describe("watch link access", () => {
  it("every /r/ route needs the job's token, and the page shell carries no recovery data", async () => {
    const { job, server, at } = await setup();
    expect(job.approveUrl).toBe(`${server.url}/r/${job.id}?t=${job.accessToken}`);
    expect(job.accessToken).toMatch(/^[A-Za-z0-9_-]{32}$/);

    expect((await fetch(`${server.url}/r/${job.id}`)).status).toBe(404);
    expect((await fetch(at("", "x".repeat(32)))).status).toBe(404);
    expect((await fetch(at("/state", "x".repeat(32)))).status).toBe(404);
    expect((await fetch(at("/events", ""))).status).toBe(404);

    const page = await fetch(at());
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("content-security-policy")).toMatch(/frame-src https:\/\/api\.steel\.dev/);
    const html = await page.text();
    expect(html).not.toContain(job.id);
    expect(html).not.toContain(job.accessToken);

    expect(await (await fetch(`${server.url}/`)).text()).not.toContain(job.id);
  });

  it("shows mandate-visible fields only: never the signature, the nonce, or the token", async () => {
    const { job, at } = await setup();
    const state = await (await fetch(at("/state"))).json();
    expect(state.phase).toBe("awaiting_approval");
    expect(state.mandate).toEqual({
      mandate_id: job.mandate!.mandateId,
      product: "c5000",
      units: 5000,
      cap: job.mandate!.maximumAmount,
      currency: "USD",
      billing: "one_time",
      auto_renew: false,
      billing_origin: "https://mock.example",
      expires_at: job.mandate!.expiresAt,
    });
    const raw = JSON.stringify(state);
    for (const secret of [job.mandate!.signature, job.mandate!.nonce, job.accessToken]) expect(raw).not.toContain(secret);
    expect(JSON.stringify(job.events)).not.toContain(job.accessToken);
  });

  it("expires the link after the recovery finishes", async () => {
    const { at, post } = await setup({ linkTtlMs: 30 });
    expect((await post("/reject")).status).toBe(204);
    await new Promise((r) => setTimeout(r, 60));
    expect((await fetch(at())).status).toBe(410);
    expect((await fetch(at("/state"))).status).toBe(410);
    expect((await fetch(at("/events"))).status).toBe(410);
  });

  it("approval from the page is bound to the mandate id it showed", async () => {
    const { post } = await setup();
    const res = await post("/approve", { mandate_id: "stale" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "MANDATE_ID_MISMATCH" });
  });
});

describe("event stream: one projection, any number of subscribers", () => {
  it("walks awaiting approval → live → takeover → live → completed with replay, and survives a close/reopen mid-run", async () => {
    const { purchaser, gates } = scriptedPurchaser();
    const { job, post, at } = await setup({ purchaser });

    const first = sse(at("/events"));
    await first.until(() => first.states().length > 0);
    expect(first.last().phase).toBe("awaiting_approval");
    expect(first.timeline().map((e) => e.seq)).toEqual(job.events.map((_, i) => i));

    expect((await post("/approve", { mandate_id: job.mandate!.mandateId })).status).toBe(204);
    await first.until(() => first.last()?.phase === "live");
    expect(first.last().viewer).toEqual({
      mode: "live",
      session_id: "sess_1",
      embed_url: `${PLAYER}?interactive=false&showControls=false`,
      interactive: false,
      dashboard_url: "https://app.steel.dev/sessions/sess_1",
    });
    // The raw player URL only travels in viewer.embed_url, never in the timeline.
    expect(JSON.stringify(first.timeline())).not.toContain("/player");

    const seen = first.timeline().at(-1)!.seq as number;
    first.close(); // the user closes the tab mid-run

    gates.takeover.resolve();
    await waitFor(() => job.takeover !== undefined);

    // Reopened: EventSource resends the last id it saw. No duplicates, current state.
    const second = sse(at("/events"), { "last-event-id": String(seen) });
    await second.until(() => second.last()?.phase === "takeover_requested");
    expect(second.timeline()[0]!.seq).toBe(seen + 1);
    expect(second.last().takeover.reason).toBe("3-DS challenge");
    expect(second.last().viewer).toMatchObject({ mode: "live", interactive: true, embed_url: `${PLAYER}?interactive=true&showControls=false` });

    // A second surface (the widget) on the same recovery sees the same state.
    const widget = sse(at("/events"));
    await widget.until(() => widget.last()?.phase === "takeover_requested");

    expect((await post("/takeover/done")).status).toBe(204);
    await second.until(() => second.last()?.phase === "live");
    expect(second.last().viewer.interactive).toBe(false);
    expect((await post("/takeover/done")).status).toBe(409);
    expect(job.events.find((e) => e.type === "TAKEOVER_HANDED_BACK")?.detail).toEqual({ by: "user" });

    gates.release.resolve();
    await second.until(() => second.last()?.phase === "completed");
    await widget.until(() => widget.last()?.phase === "completed");
    const done = second.last();
    expect(done.viewer).toEqual({ mode: "replay", session_id: "sess_1", replay_path: `/r/${job.id}/replay.m3u8`, dashboard_url: "https://app.steel.dev/sessions/sess_1" });
    expect(done.outcome.headline).toBe("Purchase verified");
    expect(done.link_expires_at).not.toBeNull();
    expect([...new Set(second.states().map((s) => s.phase))]).toEqual(["takeover_requested", "live", "completed"]);
    expect(widget.timeline().map((e) => e.seq)).toEqual(job.events.map((_, i) => i));
  });

  it("a takeover nobody answers hands the browser back on its own", async () => {
    const { purchaser, gates } = scriptedPurchaser();
    const { job, coordinator } = await setup({ purchaser, takeoverTimeoutMs: 30 });
    await coordinator.approveMandate(job.id, job.mandate!.mandateId);
    gates.takeover.resolve();
    await waitFor(() => job.events.some((e) => e.type === "TAKEOVER_HANDED_BACK"));
    expect(job.events.find((e) => e.type === "TAKEOVER_HANDED_BACK")?.detail).toEqual({ by: "timeout" });
    expect(job.takeover).toBeUndefined();
    gates.release.resolve();
    await waitFor(() => job.status === "resolved");
  });

  it("reject from the page streams the refusal", async () => {
    const { job, post, at } = await setup();
    const stream = sse(at("/events"));
    await stream.until(() => stream.last()?.phase === "awaiting_approval");
    expect((await post("/reject", { reason: "too much" })).status).toBe(204);
    await stream.until(() => stream.last()?.phase === "refused");
    expect(stream.last().outcome.headline).toBe("You declined this purchase");
    expect(stream.timeline().map((e) => e.type)).toContain("RECOVERY_FINISHED");
    expect((await post("/approve", { mandate_id: job.mandate!.mandateId })).status).toBe(409);
  });
});

describe("replay", () => {
  it("serves the released session's playlist, and says when it isn't ready yet", async () => {
    let ready = false;
    const replay: ReplaySource = {
      playlist: async (id) => (ready ? { status: "ready", body: `#EXTM3U\n#EXTINF:4.0,\nhttps://storage.example/${id}/segment_1.m4s\n` } : { status: "processing" }),
    };
    const { purchaser, gates } = scriptedPurchaser();
    const { job, coordinator, at } = await setup({ purchaser, replay });

    expect(await (await fetch(at("/replay.m3u8"))).json()).toMatchObject({ reason: "NO_SESSION" });
    await coordinator.approveMandate(job.id, job.mandate!.mandateId);
    await waitFor(() => job.live !== undefined);
    expect(await (await fetch(at("/replay.m3u8"))).json()).toMatchObject({ reason: "SESSION_LIVE" });

    gates.takeover.resolve();
    await waitFor(() => job.takeover !== undefined);
    coordinator.completeTakeover(job.id);
    gates.release.resolve();
    await waitFor(() => job.replay !== undefined);

    expect((await fetch(at("/replay.m3u8"))).status).toBe(202);
    ready = true;
    const res = await fetch(at("/replay.m3u8"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(await res.text()).toContain("sess_1/segment_1.m4s");
  });

  it("the Steel source keeps the key server-side and maps Steel's answers", async () => {
    const calls: Array<{ url: string; key: string | undefined }> = [];
    let answer = { status: 404, body: "" };
    const fetchImpl: ReplayFetch = async (url, init) => {
      calls.push({ url, key: init.headers["steel-api-key"] });
      return { ok: answer.status < 300, status: answer.status, text: async () => answer.body };
    };
    const source = steelReplaySource({ apiKey: "sk-steel", fetchImpl });

    expect(await source.playlist("abc-123")).toEqual({ status: "processing" });
    expect(calls[0]).toEqual({ url: "https://api.steel.dev/v1/sessions/abc-123/hls", key: "sk-steel" });
    answer = { status: 200, body: "#EXTM3U\n#EXT-X-VERSION:6\n" };
    expect(await source.playlist("abc-123")).toEqual({ status: "processing" });
    answer = { status: 200, body: "#EXTM3U\n#EXTINF:4.000,\nhttps://fly.storage.tigris.dev/x/segment_1.m4s?sig=1\n" };
    expect((await source.playlist("abc-123")).status).toBe("ready");
    expect((await source.playlist("abc-123")).status).toBe("ready");
    expect(calls).toHaveLength(3); // cached
    answer = { status: 401, body: "" };
    expect(await source.playlist("other")).toEqual({ status: "unavailable", reason: "STEEL_AUTH" });
    expect(await source.playlist("../../etc")).toEqual({ status: "unavailable", reason: "BAD_SESSION_ID" });
    expect(calls).toHaveLength(4);
  });
});

describe("gateway surfaces", () => {
  it("a CLI run prints one clickable watch line and returns the watch info", async () => {
    const lines: string[] = [];
    const progress: string[] = [];
    const g = createGateway({
      upstreams: loadUpstreams(),
      steel: noSteel,
      mockVendor: new MockImageVendor(0),
      env: {},
      safeBlockMs: 20,
      pollMs: 5,
      publicUrl: () => "http://127.0.0.1:8787",
      mandateSecret: SECRET,
      log: () => {},
      announce: (line) => lines.push(line),
    });
    const call = () => g.callTool("mockvendor__generate_image", { prompt: "x" }, { taskId: "t", progress: async (m) => void progress.push(m) });
    const first = await call();
    await call(); // the agent retries: it joins the recovery, and the line isn't printed twice

    const body = JSON.parse((first.content[0] as { text: string }).text);
    const job = g.coordinator.get(body.recovery_id) as RecoveryJob;
    const line = `▶ Watch live: http://127.0.0.1:8787/r/${job.id}?t=${job.accessToken}`;
    expect(lines).toEqual([line]);
    expect(progress).toContain(line);
    expect(body).toMatchObject({ status: "AWAITING_APPROVAL", display: line, watch_url: job.approveUrl });
    expect(body.next).toMatch(/Do NOT re-run the original tool/);
    expect(first.structuredContent).toEqual({
      watch: { recovery_id: job.id, status: "awaiting_approval", url: job.approveUrl, base_url: "http://127.0.0.1:8787", token: job.accessToken },
    });
    expect(g.watchRecovery(job.id).structuredContent).toMatchObject({ watch: { url: job.approveUrl } });
    expect(g.watchRecovery("nope").isError).toBe(true);
  });

  it("the widget inlines the same renderer plus the MCP Apps bridge", () => {
    const html = renderWidgetHtml();
    expect(html).toContain("window.AisleWatch");
    expect(html).toContain('"ui/initialize"');
    expect(html).toContain('"2026-01-26"');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html.match(/<\/script>/g)).toHaveLength(2);

    const meta = widgetResourceMeta("https://abc.trycloudflare.com/");
    expect(meta.ui.csp.connectDomains).toContain("https://abc.trycloudflare.com");
    expect(meta.ui.csp.resourceDomains).toContain("https://abc.trycloudflare.com");
    expect(meta.ui.csp.frameDomains).toContain("https://api.steel.dev");
  });
});

describe("projection helpers", () => {
  it("redacts secrets from timeline detail", () => {
    expect(
      redactDetail({
        sessionId: "s",
        debugUrl: "https://api.steel.dev/v1/sessions/s/player",
        nested: { mandate_signature: "sig", profileId: "p", ok: 1 },
        url: "https://aisle.dev/r/abc?t=SECRET",
      }),
    ).toEqual({ sessionId: "s", nested: { ok: 1 }, url: "https://aisle.dev/r/abc?t=…" });
  });

  it("maps job state to the lifecycle phases", () => {
    const live = { sessionId: "s", debugUrl: undefined, viewerUrl: undefined };
    const takeover = { reason: "3DS", requestedAt: "", deadline: "" };
    expect(phaseOf({ status: "awaiting_approval" })).toBe("awaiting_approval");
    expect(phaseOf({ status: "running" })).toBe("connecting");
    expect(phaseOf({ status: "running", live })).toBe("live");
    expect(phaseOf({ status: "running", live, takeover })).toBe("takeover_requested");
    for (const s of ["resolved", "dry_run_complete", "staged_not_submitted"] as const) expect(phaseOf({ status: s })).toBe("completed");
    expect(phaseOf({ status: "rejected" })).toBe("refused");
    expect(phaseOf({ status: "refused" })).toBe("refused");
    expect(phaseOf({ status: "failed" })).toBe("failed");
    expect(embedUrl("https://api.steel.dev/v1/sessions/s/player", true)).toBe("https://api.steel.dev/v1/sessions/s/player?interactive=true&showControls=false");
  });
});
