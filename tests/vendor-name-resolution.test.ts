import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchVendorByName, knownVendors, resolveExternalTarget } from "../src/web/external-action.js";
import type { Upstreams } from "../src/gateway/upstreams.js";

const ups: Upstreams = {
  higgsfield: {
    description: "", canonicalOrigin: "https://higgsfield.ai", billingOrigin: "https://higgsfield.ai",
    billingUrl: "https://higgsfield.ai/pricing", resource: "image_credits", offers: [],
  },
  openrouter: {
    description: "", canonicalOrigin: "https://openrouter.ai", billingOrigin: "https://openrouter.ai",
    billingUrl: "https://openrouter.ai/settings/credits", resource: "usd_balance", offers: [],
  },
} as unknown as Upstreams;

describe("vendor name resolution (NLP-lite, known vendors only)", () => {
  it("resolves a spoken configured-vendor name to its URL", () => {
    expect(matchVendorByName("generate an image on higgsfield", ups)).toBe("https://higgsfield.ai/pricing");
    expect(matchVendorByName("buy some openrouter credits", ups)).toBe("https://openrouter.ai/settings/credits");
  });

  it("matches across spacing/casing/punctuation", () => {
    expect(matchVendorByName("please TOP UP on Higgsfield!", ups)).toBe("https://higgsfield.ai/pricing");
  });

  it("resolves a name to a logged-in-only host (no config entry)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aisle-names-"));
    mkdirSync(join(dir, "nano-banana.example.com"), { recursive: true });
    mkdirSync(join(dir, "_browse"), { recursive: true }); // internal dir, must be ignored
    expect(matchVendorByName("generate on nano banana", ups, dir)).toBe("https://nano-banana.example.com/");
    expect(knownVendors(ups, dir).map((v) => v.name)).toContain("nano-banana.example.com");
  });

  it("NEVER guesses an unknown name into a domain", () => {
    expect(matchVendorByName("generate on some-brand-new-startup", ups)).toBeUndefined();
  });

  it("resolveExternalTarget falls back from name to a known vendor, else errors helpfully", () => {
    const t = resolveExternalTarget("top up on higgsfield", ups);
    expect(t.provider).toBe("higgsfield");
    expect(() => resolveExternalTarget("top up on a place I never set up", ups)).toThrow(/VENDOR_NOT_RECOGNIZED/);
  });

  it("an explicit https link still wins and enables the zero-integration path", () => {
    const t = resolveExternalTarget("do a thing", ups, "https://brand-new.example.com/pricing");
    expect(t.provider).toBe("brand-new.example.com"); // ad-hoc, no config
    expect(t.url).toBe("https://brand-new.example.com/pricing");
  });
});
