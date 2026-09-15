import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileProfileStore, InMemoryProfileStore, profileDirFor } from "../src/index.js";

describe("profileDirFor", () => {
  it("is a stable per-vendor directory under the base", () => {
    expect(profileDirFor("/base", "openrouter")).toBe(join("/base", "openrouter"));
    // Same vendor → same dir, so a login done once is reused by every path.
    expect(profileDirFor("/base", "openrouter")).toBe(profileDirFor("/base", "openrouter"));
  });

  it("sanitizes unsafe segments so the vendor name can't escape the base", () => {
    // Path separators become "_", so the result is always a single child of the base.
    expect(profileDirFor("/base", "../../etc/passwd")).toBe(join("/base", ".._.._etc_passwd"));
    // A pure-dots name would traverse; it is neutralized.
    expect(profileDirFor("/base", "..")).toBe(join("/base", "_"));
    expect(profileDirFor("/base", "a/b")).toBe(join("/base", "a_b"));
  });
});

describe("FileProfileStore", () => {
  it("round-trips a (user, vendor) → userDataDir binding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aisle-profiles-"));
    const store = new FileProfileStore(dir);
    expect(await store.load("local-user", "openrouter")).toBeUndefined();

    const binding = { userId: "local-user", provider: "openrouter", profileId: join(dir, "openrouter") };
    await store.save(binding);
    expect(await store.load("local-user", "openrouter")).toEqual(binding);

    // One profile per (user, vendor): a different vendor is a different file.
    expect(await store.load("local-user", "studio")).toBeUndefined();
  });
});

describe("InMemoryProfileStore", () => {
  it("upserts on (userId, provider)", async () => {
    const store = new InMemoryProfileStore();
    await store.save({ userId: "u", provider: "v", profileId: "/a" });
    await store.save({ userId: "u", provider: "v", profileId: "/b" });
    expect((await store.load("u", "v"))?.profileId).toBe("/b");
  });
});
