/**
 * Recorded adapters — tier 2 (aisle-pipeline.md §17).
 *
 * Deterministic replay of stored locators keyed by billing origin, versioned.
 * Locators are accessible role + name, never AX indexes (position-dependent)
 * and never CSS class hashes. A tier-3 cold run that reaches checkout is
 * promoted into one of these; a replay miss falls back to tier 3 and re-records.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize } from "../../policy/policy.js";
import { sha256 } from "../../core/hash.js";

export interface RecordedStep {
  action: "click" | "fill";
  role: string;
  name: string;
  /** Fill values are never recorded literally: "{price}" is the mandate-bound amount. */
  value?: "{price}";
}

export interface RecordedAdapter {
  billingOrigin: string;
  version: number;
  /** Steps from pricing to a staged checkout, per package (`units:{n}`). */
  offers: Record<string, RecordedStep[]>;
  /** The deterministic confirm control that worked last time. */
  confirm?: { role: string; name: string };
  updatedAt: string;
}

export interface AdapterRegistry {
  load(billingOrigin: string): Promise<RecordedAdapter | undefined>;
  save(adapter: RecordedAdapter): Promise<void>;
}

export class InMemoryAdapterRegistry implements AdapterRegistry {
  private readonly adapters = new Map<string, RecordedAdapter>();

  async load(billingOrigin: string): Promise<RecordedAdapter | undefined> {
    const a = this.adapters.get(canonicalize(billingOrigin));
    return a && structuredClone(a);
  }

  async save(adapter: RecordedAdapter): Promise<void> {
    this.adapters.set(canonicalize(adapter.billingOrigin), structuredClone(adapter));
  }
}

/** One JSON file per billing origin: `adapter:{billingOrigin}:{version}` lives in the file. */
export class FileAdapterRegistry implements AdapterRegistry {
  constructor(private readonly dir: string) {}

  private pathFor(billingOrigin: string): string {
    return join(this.dir, `${sha256(canonicalize(billingOrigin)).slice(0, 24)}.json`);
  }

  async load(billingOrigin: string): Promise<RecordedAdapter | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(billingOrigin), "utf8")) as RecordedAdapter;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async save(adapter: RecordedAdapter): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(adapter.billingOrigin), JSON.stringify(adapter, null, 2), "utf8");
  }
}
