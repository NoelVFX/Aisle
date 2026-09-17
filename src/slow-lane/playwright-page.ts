/**
 * Playwright-backed implementations of the `PageLike` and `ControlSurface` ports.
 *
 * Provider-agnostic: it wraps a plain Playwright `Page`, so it works for a local
 * `chromium.launchPersistentContext` browser or any CDP-connected one. The only
 * optional dependency is a `Cursor` — a visible pointer that clicks by coordinate
 * without Playwright's actionability hit-test. Local browsers pass none and use
 * Playwright's native input.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { CDPSession, Page } from "playwright-core";
import type { ActionCandidate, ControlSurface, PageLike } from "./browser.js";

/**
 * On Linux (e.g. WSL) Chromium dlopens system libs like libasound.so.2. When the
 * user can't `sudo apt install` them, we stage them (no root) under
 * ~/.aisle-native-libs/lib; put that on LD_LIBRARY_PATH so the browser child
 * process finds them. Runs once at import — before any chromium.launch — and is a
 * no-op off Linux or when the dir doesn't exist. Any launcher imports this module.
 */
(function ensureNativeLibPath(): void {
  if (process.platform !== "linux") return;
  const dir = join(homedir(), ".aisle-native-libs", "lib");
  if (!existsSync(dir)) return;
  const current = process.env["LD_LIBRARY_PATH"] ?? "";
  if (current.split(delimiter).includes(dir)) return;
  process.env["LD_LIBRARY_PATH"] = current ? `${dir}${delimiter}${current}` : dir;
})();

/** A never-settling loading element must not hang the whole flow on one action. */
export const ACTION_TIMEOUT_MS = 20_000;
/** Navigation may be slow (heavy SPA, captcha); it gets a longer budget than actions. */
export const NAVIGATION_TIMEOUT_MS = 90_000;
export const DEFAULT_DIMENSIONS = { width: 1280, height: 720 };

const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "radio",
  "checkbox",
  "combobox",
  "menuitem",
  "tab",
  "textbox",
  "spinbutton",
  "searchbox",
  "option",
  "switch",
]);
const MAX_CANDIDATES = 80;

type AxNode = { ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; backendDOMNodeId?: number };
type RoleArg = Parameters<Page["getByRole"]>[0];

/** A visible pointer that moves/clicks by viewport coordinate (no actionability wait). Optional. */
export interface Cursor {
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
}

export class PlaywrightPage implements PageLike {
  private cdp: CDPSession | undefined;

  constructor(
    private readonly page: Page,
    private readonly cursor?: Cursor,
  ) {}

  /** Click a viewport point with the visible cursor, else through Playwright. */
  private async pointClick(x: number, y: number): Promise<void> {
    if (this.cursor) {
      try {
        await this.cursor.click(x, y);
        return;
      } catch {
        // fall through to an invisible but reliable CDP click
      }
    }
    await this.page.mouse.click(x, y);
  }

  private async clickLocator(loc: ReturnType<Page["locator"]>, timeoutMs?: number): Promise<void> {
    if (this.cursor) {
      const opts = timeoutMs === undefined ? {} : { timeout: timeoutMs };
      await loc.scrollIntoViewIfNeeded(opts).catch(() => {});
      const box = await loc.boundingBox(opts).catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        // Coordinate click through the real cursor: no actionability hit-test, so
        // a target the cursor can reach is actually clicked instead of just hovered.
        return this.pointClick(box.x + box.width / 2, box.y + box.height / 2);
      }
    }
    await loc.click(timeoutMs === undefined ? {} : { timeout: timeoutMs });
  }

  private async cdpSession(): Promise<CDPSession> {
    if (!this.cdp) {
      this.cdp = await this.page.context().newCDPSession(this.page);
      await this.cdp.send("DOM.enable").catch(() => {});
      await this.cdp.send("Accessibility.enable").catch(() => {});
    }
    return this.cdp;
  }

  async jsonLd(): Promise<unknown[]> {
    return this.page.$$eval('script[type="application/ld+json"]', (els) =>
      els
        .map((e) => {
          try {
            return JSON.parse(e.textContent ?? "") as unknown;
          } catch {
            return null;
          }
        })
        .filter((x) => x !== null),
    );
  }

  /** Tier 3: real nodes from Accessibility.getFullAXTree, numbered. */
  async actionableCandidates(): Promise<ActionCandidate[]> {
    const cdp = await this.cdpSession();
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as unknown as { nodes: AxNode[] };
    const out: ActionCandidate[] = [];
    for (const n of nodes) {
      const role = String(n.role?.value ?? "");
      const name = String(n.name?.value ?? "").replace(/\s+/g, " ").trim();
      if (n.ignored || !ACTIONABLE_ROLES.has(role) || !name || n.backendDOMNodeId === undefined) continue;
      const near = await this.nearPriceText(cdp, n.backendDOMNodeId).catch(() => "");
      out.push({ index: out.length, role, name: name.slice(0, 120), near, backendNodeId: n.backendDOMNodeId });
      if (out.length >= MAX_CANDIDATES) break;
    }
    return out;
  }

  /** Walk up to three ancestors and return the first price-bearing text. */
  private async nearPriceText(cdp: CDPSession, backendNodeId: number): Promise<string> {
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId });
    if (!object.objectId) return "";
    try {
      const res = await cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration:
          "function(){let el=this;for(let i=0;i<4&&el;i++){const t=(el.innerText||'').replace(/\\s+/g,' ').trim();" +
          "if(/[$€£]\\s?\\d/.test(t))return t.slice(0,160);el=el.parentElement;}return '';}",
      });
      return typeof res.result.value === "string" ? res.result.value : "";
    } finally {
      await cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
    }
  }

  private async centerOf(candidate: ActionCandidate): Promise<{ x: number; y: number }> {
    if (candidate.backendNodeId === undefined) throw new Error("Candidate has no DOM node.");
    const cdp = await this.cdpSession();
    await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: candidate.backendNodeId }).catch(() => {});
    const { quads } = await cdp.send("DOM.getContentQuads", { backendNodeId: candidate.backendNodeId });
    const q = quads[0];
    if (!q || q.length < 8) throw new Error(`Candidate "${candidate.name}" is not visible.`);
    return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
  }

  async clickCandidate(candidate: ActionCandidate): Promise<void> {
    const { x, y } = await this.centerOf(candidate);
    await this.pointClick(x, y);
  }

  async fillCandidate(candidate: ActionCandidate, value: string): Promise<void> {
    const { x, y } = await this.centerOf(candidate);
    await this.pointClick(x, y);
    await this.page.keyboard.press("ControlOrMeta+A");
    await this.page.keyboard.type(value);
  }

  async clickByRole(role: string, name: string | RegExp): Promise<boolean> {
    const loc = this.page.getByRole(role as RoleArg, { name, exact: typeof name === "string" }).first();
    if ((await loc.count()) === 0) return false;
    await this.clickLocator(loc);
    return true;
  }

  async fillByRole(role: string, name: string | RegExp, value: string): Promise<boolean> {
    const loc = this.page.getByRole(role as RoleArg, { name, exact: typeof name === "string" }).first();
    if ((await loc.count()) === 0) return false;
    await loc.fill(value);
    return true;
  }

  async setChecked(selector: string, checked: boolean): Promise<boolean> {
    const loc = this.page.locator(selector).first();
    if ((await loc.count()) === 0) return false;
    if ((await loc.isChecked().catch(() => checked)) === checked) return false;
    await loc.setChecked(checked, { force: true });
    return true;
  }

  async settle(ms = 1500): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForTimeout(ms);
  }

  async revealByScrolling(): Promise<void> {
    // Nudge lazy content (pack lists below the fold) to render — fast, no visible
    // crawl. A few quick wheels; the picker's clickCandidate scrolls the exact
    // target into view via CDP anyway, so we don't wheel back.
    const vp = this.page.viewportSize() ?? DEFAULT_DIMENSIONS;
    const step = Math.floor(vp.height * 0.9);
    for (let i = 0; i < 4; i++) {
      await this.page.mouse.wheel(0, step).catch(() => {});
      await this.page.waitForTimeout(60);
    }
  }

  currentUrl(): string {
    return this.page.url();
  }
  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }
  async clickByText(text: string): Promise<void> {
    await this.clickLocator(this.page.getByText(text, { exact: false }).first());
  }
  async clickBySelector(selector: string, timeoutMs?: number): Promise<void> {
    // `.first()` so union/proximity selectors ("a, button", ":near(...)") don't trip
    // strict mode; route through clickLocator so a covered/animating element is
    // actually clicked (via the cursor) rather than only hovered.
    await this.clickLocator(this.page.locator(selector).first(), timeoutMs);
  }
  async hoverBySelector(selector: string, timeoutMs?: number): Promise<void> {
    const loc = this.page.locator(selector).first();
    const opts = timeoutMs === undefined ? {} : { timeout: timeoutMs };
    await loc.scrollIntoViewIfNeeded(opts).catch(() => {});
    const box = await loc.boundingBox(opts).catch(() => null);
    if (box && box.width > 0 && box.height > 0) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      if (this.cursor) return void (await this.cursor.move(x, y));
      await this.page.mouse.move(x, y);
      return;
    }
    await loc.hover(opts).catch(() => {});
  }
  async dismissOverlays(closeSelectors: string[] = []): Promise<void> {
    await this.page.keyboard.press("Escape").catch(() => {});
    for (const selector of closeSelectors) {
      const loc = this.page.locator(selector).first();
      if (!(await loc.isVisible().catch(() => false))) continue;
      await loc.click({ timeout: 1200 }).catch(() => {});
    }
  }
  async fill(selector: string, value: string): Promise<void> {
    await this.page.fill(selector, value);
  }
  async textContent(selector: string): Promise<string | null> {
    return this.page.textContent(selector);
  }
  async queryAllText(selector: string): Promise<string[]> {
    return this.page.$$eval(selector, (els) => els.map((e) => e.textContent ?? ""));
  }
  async waitForSelector(selector: string, timeoutMs?: number): Promise<void> {
    await this.page.waitForSelector(selector, timeoutMs === undefined ? {} : { timeout: timeoutMs });
  }
  async innerText(): Promise<string> {
    return this.page.locator("body").innerText();
  }
  async tryClickByText(text: string): Promise<boolean> {
    const loc = this.page.getByText(text, { exact: false }).first();
    if ((await loc.count()) === 0) return false;
    await this.clickLocator(loc);
    return true;
  }
}

export class PlaywrightControl implements ControlSurface {
  constructor(
    private readonly page: Page,
    private readonly fallbackViewport: { width: number; height: number },
  ) {}

  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot();
  }
  viewport(): { width: number; height: number } {
    return this.page.viewportSize() ?? this.fallbackViewport;
  }
  async mouseClick(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
  }
  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }
  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }
  async scroll(dx: number, dy: number): Promise<void> {
    await this.page.mouse.wheel(dx, dy);
  }
  currentUrl(): string {
    return this.page.url();
  }
}
