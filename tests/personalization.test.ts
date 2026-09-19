import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferenceModel, TONES } from "../src/agnic/personalization.js";
import type { AgnicProduct } from "../src/agnic/commerce.js";

const prod = (sku: string, title: string, price_minor?: number): AgnicProduct => ({ sku, title, ...(price_minor !== undefined ? { price_minor } : {}), currency: "USD" });
let dir: string;
const newModel = (opts = {}) => new PreferenceModel(join(dir, `pm-${Math.random().toString(36).slice(2)}.json`), { rng: () => 1, ...opts });

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "aisle-pm-")); });

describe("PreferenceModel — profile & consent", () => {
  it("stores a persona only with consent, and clears it on consent=false", () => {
    const m = newModel();
    const saved = m.setProfile({ consent: true, tags: ["Student", "budget-conscious"], budgetBand: "low" });
    expect(saved.consent).toBe(true);
    expect(saved.tags).toEqual(["student", "budget-conscious"]);
    expect(saved.budgetBand).toBe("low");
    const cleared = m.setProfile({ consent: false });
    expect(cleared).toEqual({ consent: false, tags: [] });
  });

  it("persists across instances (same file)", () => {
    const file = join(dir, "persist.json");
    new PreferenceModel(file).setProfile({ consent: true, tags: ["tech"] });
    expect(new PreferenceModel(file).profile()).toMatchObject({ consent: true, tags: ["tech"] });
  });
});

describe("PreferenceModel — attributes & tones", () => {
  it("derives coarse attributes from price band and title", () => {
    const m = newModel();
    expect(m.deriveAttrs(prod("a", "Cotton Blazer", 2000))).toEqual(["budget-friendly", "formal"]);
    expect(m.deriveAttrs(prod("b", "Wireless Charger", 9000))).toEqual(["mid-range", "tech"]);
    expect(m.deriveAttrs(prod("c", "Leather Watch", 40000))).toEqual(["premium", "accessory"]);
  });

  it("assigns distinct tones across the shortlist (greedy when not exploring)", () => {
    const m = newModel(); // rng()=1 ⇒ no exploration
    const ranked = m.rank([prod("a", "A"), prod("b", "B"), prod("c", "C")], 3);
    const tones = ranked.map((r) => r.tone);
    expect(new Set(tones).size).toBe(3);
    expect(tones).toEqual([...TONES].slice(0, 3)); // all-neutral ⇒ catalogue tone order
  });
});

describe("PreferenceModel — learning", () => {
  it("credits the shown tone + attributes when the user proceeds to buy (matched to a recent impression)", () => {
    const m = newModel();
    m.recordImpressions([{ sku: "x", tone: "value", attrs: ["formal"] }]);
    const res = m.recordConversion("x", { title: "Blazer" });
    expect(res).toEqual({ credited: true, tone: "value" });
    const s = m.stats();
    expect(s.tones.find((t) => t.tone === "value")).toMatchObject({ impressions: 1, conversions: 1 });
    expect(s.attrs.find((a) => a.attr === "formal")).toMatchObject({ impressions: 1, conversions: 1 });
    expect(s.history[0]).toMatchObject({ sku: "x", tone: "value" });
  });

  it("does not credit a sku that was never shown", () => {
    const m = newModel();
    expect(m.recordConversion("never-shown").credited).toBe(false);
  });

  it("a completed purchase adds weight ON TOP of proceed-to-buy", () => {
    const m = newModel();
    m.recordImpressions([{ sku: "k", title: "Mechanical Keyboard", tone: "value", attrs: ["tech"] }]);
    m.recordConversion("k"); // proceed: +1
    let value = m.stats().tones.find((t) => t.tone === "value");
    expect(value).toMatchObject({ impressions: 1, conversions: 1 });
    const res = m.recordPurchase("k"); // completed: +2 more
    expect(res).toEqual({ credited: true, tone: "value" });
    value = m.stats().tones.find((t) => t.tone === "value");
    expect(value?.conversions).toBe(3); // 1 (proceed) + 2 (purchase)
    expect(m.stats().attrs.find((a) => a.attr === "tech")?.conversions).toBe(3);
  });

  it("recordPurchase is a no-op for a sku that never proceeded", () => {
    expect(newModel().recordPurchase("ghost").credited).toBe(false);
  });

  it("purchaseSeeds returns recent purchase titles (empty for a first-time user)", () => {
    const m = newModel();
    expect(m.purchaseSeeds()).toEqual([]); // first-time ⇒ blank For You
    m.recordImpressions([{ sku: "k", title: "Mechanical Keyboard", tone: "value", attrs: ["tech"] }]);
    m.recordConversion("k");
    expect(m.purchaseSeeds()).toEqual(["Mechanical Keyboard"]);
  });

  it("ranks a product higher once its attribute has converted before", () => {
    const m = newModel();
    // Teach the model that "budget-friendly" converts well.
    for (let i = 0; i < 5; i++) { m.recordImpressions([{ sku: "seed", tone: "value", attrs: ["budget-friendly"] }]); m.recordConversion("seed"); }
    // p0 is first in search order (mid-range); p1 is second (budget-friendly).
    const ranked = m.rank([prod("p0", "Plain Mid", 5000), prod("p1", "Plain Cheap", 2000)], 2);
    expect(ranked[0]?.product.sku).toBe("p1"); // learned attribute overcomes search position
    expect(ranked[0]?.why).toMatch(/picked before/);
  });

  it("puts persona-matching products first when consent is given", () => {
    const m = newModel();
    m.setProfile({ consent: true, tags: ["formal"] });
    const ranked = m.rank([prod("casual", "Graphic Tee", 2000), prod("formal", "Wool Blazer", 2000)], 2);
    expect(ranked[0]?.product.sku).toBe("formal");
    expect(ranked[0]?.why).toMatch(/tags/);
  });
});
