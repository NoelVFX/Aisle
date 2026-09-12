/**
 * ControlSurface backed by Steel's `sessions.computer` API (steel-sdk ≥ 0.18).
 *
 * This matches Steel's Computer Use integration: Steel takes the screenshot and
 * executes the pixel action inside the session, so input goes through Steel's
 * own input pipeline (and its stealth/proxy/captcha setup) rather than through
 * Playwright's mouse and keyboard. The brain deciding the actions is the
 * OpenRouter resolver in `computer-use.ts`.
 */

import type { SessionComputerParams, SessionComputerResponse } from "steel-sdk/resources/sessions/sessions.js";
import type { Page } from "playwright-core";
import type { ControlSurface } from "./browser.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Visible, OS-level clicks for deterministic automation.
 *
 * Playwright clicks are CDP input events: they hit the element but never move
 * the operating-system cursor that Steel's live viewer draws. This routes a
 * click through `sessions.computer` instead, gliding the real cursor to the
 * element and clicking there, so a human watching the viewer sees it move.
 *
 * Page (viewport) coordinates are mapped to screen coordinates once per session
 * by moving the cursor into the page and reading where the page saw it — the
 * screen includes the browser's tab and address bars.
 */
export class SteelCursor {
  private offset: { x: number; y: number } | undefined;
  private last: { x: number; y: number } | undefined;

  constructor(
    private readonly client: SteelComputerClient,
    private readonly sessionId: string,
    private readonly page: Page,
    private readonly opts: { steps?: number; debug?: (message: string) => void } = {},
  ) {}

  private async run(body: SessionComputerParams): Promise<void> {
    const res = await this.client.sessions.computer(this.sessionId, body);
    if (res.error) throw new Error(`Steel computer action '${body.action}' failed: ${res.error}`);
  }

  private async calibrate(): Promise<{ x: number; y: number }> {
    if (this.offset) return this.offset;
    const vp = (await this.page.evaluate(
      `(() => { window.__aisleMouse = null;
        document.addEventListener("mousemove", (e) => { window.__aisleMouse = { x: e.clientX, y: e.clientY }; });
        return { w: innerWidth, h: innerHeight, chromeX: outerWidth - innerWidth, chromeY: outerHeight - innerHeight }; })()`,
    )) as { w: number; h: number; chromeX: number; chromeY: number };

    const fallback = { x: Math.max(0, Math.round(vp.chromeX / 2)), y: Math.max(0, vp.chromeY) };
    const probe = { x: Math.round(vp.w / 2) + fallback.x, y: Math.round(vp.h / 2) + fallback.y };
    // Two nearby moves guarantee a mousemove even if the cursor already sat at the probe.
    await this.run({ action: "move_mouse", coordinates: [probe.x - 7, probe.y - 7] });
    await this.run({ action: "move_mouse", coordinates: [probe.x, probe.y] });
    await sleep(120);
    const seen = (await this.page.evaluate("window.__aisleMouse")) as { x: number; y: number } | null;

    this.offset = seen ? { x: probe.x - seen.x, y: probe.y - seen.y } : fallback;
    this.last = probe;
    this.opts.debug?.(`cursor calibrated: offset ${JSON.stringify(this.offset)} (${seen ? "measured" : "estimated"})`);
    return this.offset;
  }

  /** Glide the OS cursor to a viewport point and left-click there. */
  async click(viewportX: number, viewportY: number): Promise<void> {
    const offset = await this.calibrate();
    const target = { x: Math.round(viewportX + offset.x), y: Math.round(viewportY + offset.y) };
    const from = this.last ?? target;
    const steps = this.opts.steps ?? 6;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const ease = t * t * (3 - 2 * t);
      await this.run({
        action: "move_mouse",
        coordinates: [Math.round(from.x + (target.x - from.x) * ease), Math.round(from.y + (target.y - from.y) * ease)],
      });
    }
    await this.run({ action: "click_mouse", button: "left", coordinates: [target.x, target.y] });
    this.last = target;
  }
}

/** The slice of the Steel client this surface needs. Structural, so tests can fake it. */
export interface SteelComputerClient {
  sessions: {
    computer(sessionId: string, body: SessionComputerParams): PromiseLike<SessionComputerResponse>;
  };
}

export class SteelComputerControl implements ControlSurface {
  constructor(
    private readonly client: SteelComputerClient,
    private readonly sessionId: string,
    private readonly dimensions: { width: number; height: number },
    /** Steel's computer API doesn't report the URL; read it from the CDP page. */
    private readonly urlOf: () => string,
  ) {}

  private async run(body: SessionComputerParams): Promise<SessionComputerResponse> {
    const res = await this.client.sessions.computer(this.sessionId, body);
    if (res.error) throw new Error(`Steel computer action '${body.action}' failed: ${res.error}`);
    return res;
  }

  async screenshot(): Promise<Uint8Array> {
    const res = await this.run({ action: "take_screenshot" });
    if (!res.base64_image) throw new Error("Steel computer take_screenshot returned no image.");
    return new Uint8Array(Buffer.from(res.base64_image, "base64"));
  }

  viewport(): { width: number; height: number } {
    return this.dimensions;
  }

  async mouseClick(x: number, y: number): Promise<void> {
    await this.run({ action: "click_mouse", button: "left", coordinates: [Math.round(x), Math.round(y)] });
  }

  async type(text: string): Promise<void> {
    await this.run({ action: "type_text", text });
  }

  async pressKey(key: string): Promise<void> {
    await this.run({ action: "press_key", keys: [key] });
  }

  async scroll(dx: number, dy: number): Promise<void> {
    const center = [Math.round(this.dimensions.width / 2), Math.round(this.dimensions.height / 2)];
    await this.run({ action: "scroll", coordinates: center, delta_x: dx, delta_y: dy });
  }

  currentUrl(): string {
    return this.urlOf();
  }
}
