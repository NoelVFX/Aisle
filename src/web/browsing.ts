/**
 * The browsing session — a local Chromium window the user browses while Aisle
 * watches the wire.
 *
 *   - one persistent local browse profile (headed) the user can drive
 *   - a CDP Network listener on EVERY page, including new tabs
 *   - 402/403/429 from an enrolled origin → recovery; unenrolled → toast only
 *   - freeze the viewer during recovery; the approval card lives in Aisle's own
 *     page, and the recovery runs in the vendor's own persistent profile
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { DEFAULT_DIMENSIONS } from "../slow-lane/playwright-page.js";
import type { RecoveryCoordinator, RecoveryJob } from "../gateway/recovery.js";
import type { FileEnrollmentStore } from "./enrollments.js";
import { handleWireResponse } from "./detector.js";

export interface BrowsingDeps {
  coordinator: RecoveryCoordinator;
  enrollments: FileEnrollmentStore;
  userId: string;
  /** Base dir for the persistent local browse profile. */
  profilesDir: string;
  headed?: boolean;
  log: (message: string) => void;
}

export interface BrowsingToast {
  id: string;
  at: string;
  kind: "enrollment" | "info" | "error";
  message: string;
  origin?: string;
}

export interface BrowsingView {
  active: boolean;
  sessionId?: string;
  debugUrl?: string;
  currentUrl?: string;
  frozen: boolean;
  frozenReason?: string;
  recoveryId?: string;
  /** While the worker session buys, the viewer pane swaps to it (§6). */
  workerDebugUrl?: string;
  /** Shown over the worker browser, e.g. while Aisle waits for the user to sign in there. */
  workerLabel?: string;
  toasts: BrowsingToast[];
  startedAt?: string;
}

export class BrowsingManager {
  private context: BrowserContext | undefined;
  private view: BrowsingView = { active: false, frozen: false, toasts: [] };
  private readonly attached = new WeakSet<Page>();
  private readonly suggested = new Set<string>();

  constructor(private readonly deps: BrowsingDeps) {}

  state(): BrowsingView {
    const page = this.context?.pages().at(-1);
    return { ...this.view, ...(page ? { currentUrl: page.url() } : {}), toasts: [...this.view.toasts] };
  }

  private toast(kind: BrowsingToast["kind"], message: string, origin?: string): void {
    this.view.toasts = [...this.view.toasts.slice(-9), { id: randomUUID(), at: new Date().toISOString(), kind, message, ...(origin ? { origin } : {}) }];
  }

  dismissToast(id: string): void {
    this.view.toasts = this.view.toasts.filter((t) => t.id !== id);
  }

  async start(startUrl?: string): Promise<BrowsingView> {
    if (this.view.active) return this.state();
    const userDataDir = join(this.deps.profilesDir, "_browse");
    mkdirSync(userDataDir, { recursive: true });
    const sessionId = `browse_${randomUUID().slice(0, 8)}`;
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: this.deps.headed === false,
      viewport: DEFAULT_DIMENSIONS,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      this.context = context;

      // Every page, not just the first: 402s in new tabs are most of them.
      for (const p of context.pages()) await this.attach(p);
      context.on("page", (p) => void this.attach(p));

      this.view = {
        active: true,
        sessionId,
        frozen: false,
        toasts: [],
        startedAt: new Date().toISOString(),
      };
      this.deps.log(`[aisle:web] local browsing session ${sessionId} live`);
      if (startUrl) await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      return this.state();
    } catch (err) {
      await context.close().catch(() => {});
      this.context = undefined;
      throw err;
    }
  }

  async navigate(url: string): Promise<void> {
    const page = this.context?.pages().at(-1);
    if (!page) throw new Error("No active browsing session.");
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }

  /** For automated tests: click a control by accessible role + name in the active page. */
  async clickByRole(role: string, name: string): Promise<void> {
    const page = this.context?.pages().at(-1);
    if (!page) throw new Error("No active browsing session.");
    await page.getByRole(role as Parameters<Page["getByRole"]>[0], { name, exact: true }).first().click();
  }

  async stop(): Promise<void> {
    const id = this.view.sessionId;
    await this.context?.close().catch(() => {});
    this.context = undefined;
    this.view = { active: false, frozen: false, toasts: [] };
    this.deps.log(`[aisle:web] local browsing session ${id ?? "-"} closed`);
  }

  private async attach(page: Page): Promise<void> {
    if (this.attached.has(page) || !this.context) return;
    this.attached.add(page);
    const cdp = await this.context.newCDPSession(page);
    await cdp.send("Network.enable");

    // The body is only readable once loading finishes; hold the response until then.
    const pending = new Map<string, { status: number; url: string; headers: Record<string, string> }>();
    cdp.on("Network.responseReceived", (e) => {
      if ([402, 403, 429].includes(e.response.status)) {
        pending.set(e.requestId, { status: e.response.status, url: e.response.url, headers: e.response.headers as Record<string, string> });
      }
    });
    const settle = (requestId: string, bodyReadable: boolean) => {
      const response = pending.get(requestId);
      if (!response) return;
      pending.delete(requestId);
      void handleWireResponse(
        {
          ...response,
          getBody: async () =>
            bodyReadable ? (await cdp.send("Network.getResponseBody", { requestId })).body : undefined, // evicted → low confidence
        },
        {
          lookupEnrollment: (origin) => this.deps.enrollments.byOrigin(this.deps.userId, origin),
          suggestEnrollment: (origin, status) => {
            if (this.suggested.has(origin)) return;
            this.suggested.add(origin);
            this.toast("enrollment", `${origin} returned ${status}. Connect this vendor to let Aisle handle it.`, origin);
          },
          openRecovery: (input) => this.openRecovery(page, input.enrollment.provider, input.blocker, input.url),
        },
      ).catch((err: unknown) => this.toast("error", `Detector error: ${err instanceof Error ? err.message : String(err)}`));
    };
    cdp.on("Network.loadingFinished", (e) => settle(e.requestId, true));
    cdp.on("Network.loadingFailed", (e) => settle(e.requestId, false));
  }

  private async openRecovery(page: Page, provider: string, blocker: Parameters<RecoveryCoordinator["open"]>[0]["blocker"], url: string): Promise<void> {
    const sessionId = this.view.sessionId;
    if (!sessionId) return;
    const job = await this.deps.coordinator.open({
      taskId: `web_${sessionId}`,
      toolCallId: randomUUID(),
      namespace: provider,
      tool: `web ${new URL(url).pathname}`,
      arguments: { url },
      blocker,
      surface: "web",
    });
    if (this.view.recoveryId === job.id) return; // joined the recovery already on screen

    // Freeze the viewer: no state divergence while the purchase is decided (§2.3).
    this.view.frozen = true;
    this.view.frozenReason = `Paused: ${provider} needs a top-up. Review the approval card.`;
    this.view.recoveryId = job.id;
    this.deps.log(`[aisle:web] ${blocker.type} on ${url} → recovery ${job.id}`);
    void this.watch(job, page);
  }

  private async watch(job: RecoveryJob, page: Page): Promise<void> {
    const final = await this.deps.coordinator.wait(job.id, 30 * 60_000, (j) => {
      this.view.workerDebugUrl = j.live?.debugUrl;
      this.view.workerLabel = j.live?.interactive
        ? j.live.takeoverReason === "LOGIN_REQUIRED"
          ? `Aisle needs you: sign in to ${j.namespace} here. The purchase continues automatically.`
          : `Aisle needs you: clear the verification here. Aisle then checks the balance.`
        : undefined;
      if (j.status === "running") this.view.frozenReason = `Aisle is buying on ${j.namespace} in a separate browser.`;
    });
    this.view.workerDebugUrl = undefined;
    this.view.workerLabel = undefined;

    if (final.status === "resolved") {
      this.toast("info", `Top-up verified on ${final.namespace}. Reloading the page.`);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    } else {
      const reason = final.refusal?.message ?? final.error ?? final.status;
      this.toast(final.status === "rejected" ? "info" : "error", `Recovery ${final.status}: ${reason}`);
    }
    this.view.frozen = false;
    delete this.view.frozenReason;
    delete this.view.recoveryId;
  }
}
