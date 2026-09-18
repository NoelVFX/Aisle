import { describe, it, expect } from "vitest";
import { classifyTrack } from "../src/agnic/classify.js";
import type { OpenRouterFetch } from "../src/slow-lane/computer-use.js";

function mockOR(content: string, ok = true): OpenRouterFetch {
  return async () => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });
}

describe("classifyTrack — heuristics (no model call)", () => {
  it("routes obvious physical goods to the physical track", async () => {
    for (const p of ["a hex token fidget", "studio headphones shipped to me", "a ceramic mug", "buy me a mechanical keyboard"]) {
      const r = await classifyTrack(p, { disableLlm: true });
      expect(r.track, p).toBe("physical");
      expect(r.source).toBe("heuristic");
    }
  });

  it("routes obvious digital goods to the saas track", async () => {
    for (const p of ["the Resend Pro plan", "top up 100 credits", "an API subscription", "buy an MCP server license"]) {
      const r = await classifyTrack(p, { disableLlm: true });
      expect(r.track, p).toBe("saas");
      expect(r.source).toBe("heuristic");
    }
  });

  it("defaults an ambiguous ask (no keywords, no model) to a product, honestly low-confidence", async () => {
    const r = await classifyTrack("a coffee grinder", { disableLlm: true });
    expect(r.track).toBe("physical");
    expect(r.source).toBe("default");
    expect(r.confidence).toBeLessThan(0.6);
  });

  it("leans a bare checkout URL toward saas when nothing else signals", async () => {
    const r = await classifyTrack("buy it at https://example.com/checkout", { disableLlm: true });
    expect(r.track).toBe("saas");
    expect(r.source).toBe("default");
  });
});

describe("classifyTrack — LLM fallback", () => {
  it("uses the model only when keywords are ambiguous", async () => {
    let called = false;
    const fetchImpl: OpenRouterFetch = async (...a) => { called = true; return mockOR('{"track":"saas","confidence":0.9,"reason":"email API"}')(...a); };
    const r = await classifyTrack("something to send emails from my app", { apiKey: "k", fetchImpl });
    expect(called).toBe(true);
    expect(r).toMatchObject({ track: "saas", source: "llm" });
    expect(r.confidence).toBeCloseTo(0.9);
  });

  it("does NOT call the model when the heuristic already decided", async () => {
    let called = false;
    const fetchImpl: OpenRouterFetch = async (...a) => { called = true; return mockOR('{"track":"saas"}')(...a); };
    const r = await classifyTrack("a hex token fidget", { apiKey: "k", fetchImpl });
    expect(called).toBe(false);
    expect(r.source).toBe("heuristic");
  });

  it("falls back to the keyword lean when the model errors", async () => {
    const r = await classifyTrack("a coffee grinder", { apiKey: "k", fetchImpl: mockOR("", false) });
    expect(r.track).toBe("physical");
    expect(r.source).toBe("default");
  });
});
