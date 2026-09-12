/**
 * Browser port interfaces.
 *
 * The slow lane drives a *real* browser (Steel Cloud + Playwright over CDP), but
 * everything here is expressed against narrow interfaces so the worker, adapters
 * and tests never import Playwright directly. The Steel provider
 * (`steel-provider.ts`) implements these with a live remote browser; the mock
 * provider implements them against an in-memory vendor model.
 *
 * Two surfaces, deliberately separated:
 *   - `PageLike`        — deterministic DOM automation (the common, cheap path).
 *   - `ControlSurface`  — pixel-level input for the computer-use fallback.
 */

/** Minimal subset of a Playwright Page the deterministic adapters rely on. */
export interface PageLike {
  currentUrl(): string;
  goto(url: string): Promise<void>;
  clickByText(text: string): Promise<void>;
  clickBySelector(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  /** Text content of every element matching the selector. */
  queryAllText(selector: string): Promise<string[]>;
  waitForSelector(selector: string, timeoutMs?: number): Promise<void>;
}

/** Pixel-level control, used only by the computer-use fallback. */
export interface ControlSurface {
  screenshot(): Promise<Uint8Array>;
  viewport(): { width: number; height: number };
  mouseClick(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  currentUrl(): string;
}

/**
 * A persisted browser profile — Steel's "session context" (cookies +
 * localStorage + origins). Opaque to us; we only store and replay it so the
 * vendor stays authenticated across recovery sessions.
 */
export interface BrowserProfile {
  provider: string;
  context: unknown;
  savedAt: string;
}

export interface CreateSessionOptions {
  provider: string;
  /** Resume a saved profile to reuse authenticated vendor state. */
  profile?: BrowserProfile;
}

/** A live browser session bound to one vendor. */
export interface BrowserSession {
  readonly sessionId: string;
  readonly provider: string;
  /** Live session viewer URL (Steel) — part of the audit trail. */
  readonly sessionViewerUrl?: string;
  readonly page: PageLike;
  readonly control: ControlSurface;
  /** Capture the current auth/cookie state as a reusable profile. */
  saveProfile(): Promise<BrowserProfile>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  createSession(opts: CreateSessionOptions): Promise<BrowserSession>;
}

/** Derive the canonical origin (scheme + host[:port]) from a URL. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
