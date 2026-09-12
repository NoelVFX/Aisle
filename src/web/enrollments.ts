/**
 * Enrollments — the origin lock for the web path (web-path.md §4).
 *
 * The web path has no config file: the user browses anywhere, and any site can
 * return a 402 saying whatever it likes. So the user connects a vendor first.
 * `canonicalOrigin` and `billingOrigin` come from the vendor catalogue
 * (upstreams.json) at enrollment time — never from a 402 body or a page link.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sameOrigin } from "../policy/policy.js";
import type { Upstreams } from "../gateway/upstreams.js";

export interface Enrollment {
  userId: string;
  provider: string;
  canonicalOrigin: string;
  billingOrigin: string;
  enrolledAt: string;
}

export class FileEnrollmentStore {
  constructor(
    private readonly file: string,
    private readonly catalogue: Upstreams,
  ) {}

  private readAll(): Enrollment[] {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Enrollment[];
    } catch {
      return [];
    }
  }

  private writeAll(rows: Enrollment[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(rows, null, 2));
  }

  list(userId: string): Enrollment[] {
    return this.readAll().filter((e) => e.userId === userId);
  }

  /** Enroll a catalogue vendor. Origins are copied from the catalogue, never supplied by the caller. */
  enroll(userId: string, provider: string): Enrollment {
    const upstream = this.catalogue[provider];
    if (!upstream) throw new Error(`Unknown vendor '${provider}'.`);
    const row: Enrollment = {
      userId,
      provider,
      canonicalOrigin: upstream.canonicalOrigin,
      billingOrigin: upstream.billingOrigin,
      enrolledAt: new Date().toISOString(),
    };
    this.writeAll([...this.readAll().filter((e) => !(e.userId === userId && e.provider === provider)), row]);
    return row;
  }

  unenroll(userId: string, provider: string): void {
    this.writeAll(this.readAll().filter((e) => !(e.userId === userId && e.provider === provider)));
  }

  /**
   * The enrollment a wire response belongs to. Rows whose catalogue origins have
   * since changed (e.g. a new tunnel URL) are ignored rather than trusted.
   */
  byOrigin(userId: string, origin: string): Enrollment | undefined {
    return this.list(userId).find((e) => {
      const upstream = this.catalogue[e.provider];
      if (!upstream || !sameOrigin(upstream.canonicalOrigin, e.canonicalOrigin) || !sameOrigin(upstream.billingOrigin, e.billingOrigin)) {
        return false;
      }
      return sameOrigin(origin, e.canonicalOrigin) || sameOrigin(origin, e.billingOrigin);
    });
  }
}
