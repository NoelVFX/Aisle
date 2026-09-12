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
  /**
   * Whole-page visible text. Used by the generic adapter for heuristic price /
   * balance extraction. Read-only (no click) so the isTrusted concern doesn't
   * apply.
   */
  innerText(): Promise<string>;
  /**
   * Click the first element containing `text` IF present, returning whether it
   * clicked. Never throws on absence — lets the generic adapter try a list of
   * candidate labels. Goes through the real input pipeline (isTrusted:true).
   */
  tryClickByText(text: string): Promise<boolean>;

  // ---- Optional rich capabilities (Playwright/CDP providers). Adapters must work without them.

  /** Parsed `script[type="application/ld+json"]` blocks — tier 1 (aisle-pipeline.md §17). */
  jsonLd?(): Promise<unknown[]>;
  /** Numbered actionable nodes from the accessibility tree — tier 3. */
  actionableCandidates?(): Promise<ActionCandidate[]>;
  /** Click a candidate through real input (isTrusted). */
  clickCandidate?(candidate: ActionCandidate): Promise<void>;
  /** Focus a candidate field and type a value. */
  fillCandidate?(candidate: ActionCandidate, value: string): Promise<void>;
  /** Click the first control with this role and accessible name; false when absent. */
  clickByRole?(role: string, name: string | RegExp): Promise<boolean>;
  /** Fill the first control with this role and accessible name; false when absent. */
  fillByRole?(role: string, name: string | RegExp, value: string): Promise<boolean>;
  /** Let navigation and client-side rendering settle after an action. */
  settle?(ms?: number): Promise<void>;
}

/**
 * One real, actionable node offered to the tier-3 picker. The model returns
 * `index`; `backendNodeId` never leaves this process and is never recorded.
 */
export interface ActionCandidate {
  index: number;
  role: string;
  name: string;
  /** Nearby price-bearing text, to tell "Buy" buttons apart. */
  near: string;
  backendNodeId?: number;
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
 * The Steel profile bound to one (user, vendor) — a `vendor_profiles` row
 * (steel.md §6). Steel holds the browser identity; we hold the pointer to it
 * and the egress it is pinned to.
 *
 * ⚠ `profileId` is credential-tier: anyone who can create a session with it
 * drives a browser logged in as this user. Keep it out of logs, events, tool
 * results and model prompts.
 */
export interface BrowserProfile {
  userId: string;
  provider: string;
  profileId: string;
  /** Steel dedicated IP (`fixed:…`) pinned to this profile. */
  dedicatedIpId?: string;
  /** When a job on this profile last ended with a verified entitlement. */
  lastVerifiedAt?: string;
}

/** The profile a live session runs on, as the provider mounted it. */
export interface ProfileMount {
  profileId: string;
  dedicatedIpId?: string;
}

/** Where a released profile's write ended up (Steel: UPLOADING → READY | FAILED). */
export type ProfileReadiness = "READY" | "FAILED" | "TIMEOUT";

export interface CreateSessionOptions {
  provider: string;
  /** Restore this profile and its pinned IP. Omit to have the provider create a profile. */
  profile?: BrowserProfile;
  /**
   * Write the session's state back to the profile on release. Default true.
   * Read-only sessions pass false so they never mutate the stored identity (steel.md §4.2).
   */
  persistProfile?: boolean;
}

/** A live browser session bound to one vendor. */
export interface BrowserSession {
  readonly sessionId: string;
  readonly provider: string;
  /** Live session viewer URL (Steel) — part of the audit trail. */
  readonly sessionViewerUrl?: string;
  readonly page: PageLike;
  readonly control: ControlSurface;
  /** The profile this session runs on, restored or newly created. */
  readonly profile?: ProfileMount | undefined;
  /**
   * List receipt/invoice/license files the session accumulated (Steel Files API),
   * for the audit trail. Optional — mocks and non-Steel providers may omit it.
   */
  listReceiptFiles?(): Promise<string[]>;
  /** Release the session. For Steel this starts the profile write. */
  close(): Promise<void>;
}

export interface BrowserProvider {
  createSession(opts: CreateSessionOptions): Promise<BrowserSession>;
  /**
   * Wait for a released profile to finish persisting. A session created on it
   * before READY restores stale state. Optional for providers without profiles.
   */
  waitForProfileReady?(profileId: string): Promise<ProfileReadiness>;
}

/** Derive the canonical origin (scheme + host[:port]) from a URL. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
