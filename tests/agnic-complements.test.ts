import { describe, it, expect } from "vitest";
import { complementQueries, heuristicComplements } from "../src/agnic/complements.js";
import type { OpenRouterFetch } from "../src/slow-lane/computer-use.js";

const mockOR = (content: string, ok = true): OpenRouterFetch => async () => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });

describe("complements", () => {
  it("maps a product to sensible complements via the heuristic map", () => {
    expect(heuristicComplements("Mechanical Keyboard")).toEqual(["mouse", "mouse pad", "wrist rest"]);
    expect(heuristicComplements("Wool Blazer")).toEqual(["dress shirt", "tie", "leather shoes"]);
    expect(heuristicComplements("a mysterious widget")).toEqual([]);
  });

  it("uses the heuristic when the LLM is disabled", async () => {
    expect(await complementQueries("keyboard", { disableLlm: true })).toEqual(["mouse", "mouse pad", "wrist rest"]);
  });

  it("uses model output when available", async () => {
    const q = await complementQueries("espresso machine", { apiKey: "k", fetchImpl: mockOR('["descaling solution","milk frother","coffee beans"]') });
    expect(q).toEqual(["descaling solution", "milk frother", "coffee beans"]);
  });

  it("falls back to the heuristic when the model errors, and returns [] for an unknown item offline", async () => {
    expect(await complementQueries("keyboard", { apiKey: "k", fetchImpl: mockOR("", false) })).toEqual(["mouse", "mouse pad", "wrist rest"]);
    expect(await complementQueries("mysterious widget", { disableLlm: true })).toEqual([]);
  });
});
