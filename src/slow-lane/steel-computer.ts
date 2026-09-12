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
import type { ControlSurface } from "./browser.js";

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
