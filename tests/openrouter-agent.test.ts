import { describe, it, expect } from "vitest";
import {
  GenericVendorAdapter,
  InfraBlockedError,
  createOpenRouterComputerUseAgent,
  parseComputerUseAction,
  runSlowLane,
} from "../src/index.js";
import type { OpenRouterFetch } from "../src/index.js";
import { MockBrowserProvider, MockVendorSite } from "../src/slow-lane/adapters/mock-vendor-site.js";
import { makeRequest, SECRET } from "./fixtures.js";

const PROVIDER = "openrouter-vendor";
const ORIGIN = "https://shop.mock-slow-vendor.test";

/** Fake OpenRouter endpoint that replays a queue of assistant contents and records bodies. */
function fakeFetch(contents: string[], bodies: unknown[] = [], status = 200): OpenRouterFetch {
  let i = 0;
  return async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const content = contents[Math.min(i, contents.length - 1)] ?? "";
    i++;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify({ model: "openai/gpt-5", choices: [{ message: { content } }] }),
    };
  };
}

describe("parseComputerUseAction", () => {
  it("parses a bare JSON action", () => {
    expect(parseComputerUseAction('{"action":"click","x":10,"y":20}')).toEqual({ type: "click", x: 10, y: 20 });
  });
  it("tolerates code fences and prose", () => {
    expect(parseComputerUseAction('Sure:\n```json\n{"action":"done","success":true}\n```')).toEqual({
      type: "done",
      success: true,
      note: undefined,
    });
  });
  it("rejects clicks without numeric coordinates", () => {
    expect(parseComputerUseAction('{"action":"click","x":"left"}')).toBeUndefined();
  });
  it("returns undefined on non-JSON", () => {
    expect(parseComputerUseAction("I cannot find it")).toBeUndefined();
  });
});

describe("OpenRouter resolver", () => {
  it("drives the control surface with Nemotron 3 Nano Omni by default", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, failDiscoverUntilAssisted: true });
    const session = await new MockBrowserProvider(site).createSession({ provider: PROVIDER });
    const bodies: Array<Record<string, unknown>> = [];
    const used: Array<string | undefined> = [];
    const agent = createOpenRouterComputerUseAgent({
      apiKey: "infra-key",
      fetchImpl: fakeFetch(['{"action":"click","x":50,"y":60}', '{"action":"done","success":true}'], bodies),
      onModelCall: (i) => used.push(i.modelUsed),
    });

    const outcome = await agent.run(session.control, "reveal pricing");
    expect(outcome.success).toBe(true);
    expect(site.discoverUnlocked).toBe(true);
    expect(bodies[0]?.["model"]).toBe("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free");
    expect(bodies[0]?.["models"]).toBeUndefined();
    expect(bodies[0]?.["reasoning"]).toEqual({ exclude: true });
    expect(Number(bodies[0]?.["max_tokens"])).toBeGreaterThanOrEqual(2048);
    expect(used).toEqual(["openai/gpt-5", "openai/gpt-5"]);
  });

  it("sends a models failover array only when one is configured", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN });
    const session = await new MockBrowserProvider(site).createSession({ provider: PROVIDER });
    const bodies: Array<Record<string, unknown>> = [];
    const agent = createOpenRouterComputerUseAgent({
      apiKey: "infra-key",
      fallbackModels: ["some/other-vision-model"],
      fetchImpl: fakeFetch(['{"action":"done","success":true}'], bodies),
    });
    await agent.run(session.control, "anything");
    expect(bodies[0]?.["models"]).toEqual(["some/other-vision-model"]);
  });

  it("fails loud with INFRA_BLOCKED when the resolver key itself 402s (§16.5)", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN });
    const session = await new MockBrowserProvider(site).createSession({ provider: PROVIDER });
    const agent = createOpenRouterComputerUseAgent({ apiKey: "drained", fetchImpl: fakeFetch([""], [], 402) });
    await expect(agent.run(session.control, "anything")).rejects.toBeInstanceOf(InfraBlockedError);
  });

  it("requires OPENROUTER_INFRA_KEY, not a vendor key", () => {
    const prev = process.env["OPENROUTER_INFRA_KEY"];
    delete process.env["OPENROUTER_INFRA_KEY"];
    try {
      expect(() => createOpenRouterComputerUseAgent()).toThrow(/OPENROUTER_INFRA_KEY/);
    } finally {
      if (prev !== undefined) process.env["OPENROUTER_INFRA_KEY"] = prev;
    }
  });
});

describe("slow lane end-to-end with the OpenRouter resolver", () => {
  it("recovers a stuck discovery step", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, failDiscoverUntilAssisted: true });
    const agent = createOpenRouterComputerUseAgent({
      apiKey: "infra-key",
      fetchImpl: fakeFetch(['{"action":"click","x":100,"y":200}', '{"action":"done","success":true}']),
    });
    const result = await runSlowLane(makeRequest({ provider: PROVIDER, origin: ORIGIN, productId: "gen_5000_20" }), {
      provider: new MockBrowserProvider(site),
      adapter: new GenericVendorAdapter({ provider: PROVIDER, origin: ORIGIN }),
      agent,
      mandateSecret: SECRET,
    });
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });
});
