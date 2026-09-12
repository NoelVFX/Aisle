/**
 * Profile persistence — Steel's "profile saving".
 *
 * After a recovery session authenticates to a vendor, we capture its session
 * context (cookies + localStorage) as a `BrowserProfile` and store it, so the
 * next recovery resumes already-logged-in instead of hitting a login wall mid
 * purchase. The store is a simple port; back it with anything durable.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserProfile } from "./browser.js";

export interface ProfileStore {
  load(provider: string): Promise<BrowserProfile | undefined>;
  save(profile: BrowserProfile): Promise<void>;
}

export class InMemoryProfileStore implements ProfileStore {
  private readonly profiles = new Map<string, BrowserProfile>();

  async load(provider: string): Promise<BrowserProfile | undefined> {
    return this.profiles.get(provider);
  }

  async save(profile: BrowserProfile): Promise<void> {
    this.profiles.set(profile.provider, profile);
  }
}

/** JSON-file-backed store, one file per provider under `dir`. */
export class FileProfileStore implements ProfileStore {
  constructor(private readonly dir: string) {}

  private pathFor(provider: string): string {
    const safe = provider.replace(/[^a-z0-9_.-]/gi, "_");
    return join(this.dir, `${safe}.profile.json`);
  }

  async load(provider: string): Promise<BrowserProfile | undefined> {
    try {
      const raw = await readFile(this.pathFor(provider), "utf8");
      return JSON.parse(raw) as BrowserProfile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async save(profile: BrowserProfile): Promise<void> {
    const path = this.pathFor(profile.provider);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(profile, null, 2), "utf8");
  }
}
