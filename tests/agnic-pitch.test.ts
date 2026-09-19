import { describe, it, expect } from "vitest";
import { generatePitches, distillPersona } from "../src/agnic/pitch.js";
import type { RankedItem } from "../src/agnic/personalization.js";
import type { AgnicProduct } from "../src/agnic/commerce.js";
import type { OpenRouterFetch } from "../src/slow-lane/computer-use.js";

const mockOR = (content: string, ok = true): OpenRouterFetch => async () => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });
const p = (sku: string, title: string): AgnicProduct => ({ sku, title, price_minor: 2000, currency: "USD" });
const item = (sku: string, tone: RankedItem["tone"]): RankedItem => ({ product: p(sku, `Item ${sku}`), tone, attrs: ["mid-range"], score: 1, why: "x" });

describe("generatePitches", () => {
  it("falls back to templated pitches (no LLM) — one per item, in its tone", async () => {
    const out = await generatePitches([item("a", "value"), item("b", "playful")], { consent: false, tags: [] }, { disableLlm: true });
    expect(out).toHaveLength(2);
    expect(out[0]?.pitch).toMatch(/value/i);
    expect(out[1]?.pitch).toMatch(/🎉/);
  });

  it("uses model pitches when available and fills gaps from the template", async () => {
    const fetchImpl = mockOR(JSON.stringify([{ i: 0, pitch: "Model-written pitch for A" }])); // no entry for i=1
    const out = await generatePitches([item("a", "expert"), item("b", "value")], { consent: false, tags: [] }, { apiKey: "k", fetchImpl });
    expect(out[0]?.pitch).toBe("Model-written pitch for A");
    expect(out[1]?.pitch).toMatch(/value/i); // fallback
  });

  it("falls back cleanly when the model errors", async () => {
    const out = await generatePitches([item("a", "value")], { consent: false, tags: [] }, { apiKey: "k", fetchImpl: mockOR("", false) });
    expect(out[0]?.pitch).toMatch(/value/i);
  });
});

describe("distillPersona", () => {
  it("distills freeform text to tags via keywords (no LLM)", async () => {
    const r = await distillPersona("I'm a uni student on a tight budget, smart-casual style", { disableLlm: true });
    expect(r.tags).toEqual(expect.arrayContaining(["student", "budget-conscious", "smart-casual"]));
    expect(r.budgetBand).toBe("low");
  });

  it("uses the model when available", async () => {
    const r = await distillPersona("hardware hacker who loves premium gear", { apiKey: "k", fetchImpl: mockOR('{"tags":["tech","premium-seeker"],"budget":"high"}') });
    expect(r.tags).toEqual(["tech", "premium-seeker"]);
    expect(r.budgetBand).toBe("high");
  });

  it("returns nothing for empty input", async () => {
    expect(await distillPersona("   ", { disableLlm: true })).toEqual({ tags: [] });
  });
});
