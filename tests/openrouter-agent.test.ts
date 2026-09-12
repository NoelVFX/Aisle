import { describe, it, expect } from "vitest";
import {
  createOpenRouterComputerUseAgent,
  parseComputerUseAction,
  runSlowLane,
  GenericVendorAdapter,
} from "../src/index.js";
import type { OpenRouterFetch } from "../src/index.js";
import {
  MockBrowserProvider,
  MockVendorSite,
} from "../src/slow-lane/adapters/mock-vendor-site.js";
import type { FastLaneRequest } from "../src/types.js";

const PROVIDER = "openrouter-vendor";
const ORIGIN = "https://shop.mock-slow-vendor.test";

/** Fake OpenRouter endpoint that replays a queue of assistant contents. */
function fakeFetch(contents: string[]): OpenRouterFetch {
  let i = 0;
  return async () => {
    const content = contents[Math.min(i, contents.length - 1)] ?? "";
    i++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  };
}

describe("parseComputerUseAction", () => {
  it("parses a bare JSON action", () => {
    expect(parseComputerUseAction('{"action":"click","x":10,"y":20}')).toEqual({
      type: "click",
      x: 10,
      y: 20,
    });
  });
  it("tolerates code fences and prose", () => {
    const out = parseComputerUseAction('Sure:\n```json\n{"action":"done","success":true}\n```');
    expect(out).toEqual({ type: "done", success: true, note: undefined });
  });
  it("returns undefined on non-JSON", () => {
    expect(parseComputerUseAction("I cannot find it")).toBeUndefined();
  });
});

describe("OpenRouter agent drives the control surface", () => {
  it("executes actions until done", async () => {
    const site = new MockVendorSite({ provider: PROVIDER, origin: ORIGIN, failDiscoverUntilAssisted: true });
    const session = await new MockBrowserProvider(site).createSession({ provider: PROVIDER });
    const agent = createOpenRouterComputerUseAgent({
      apiKey: "test-key",
      fetchImpl: fakeFetch(['{"action":"click","x":50,"y":60}', '{"action":"done","success":true}']),
    });

    const outcome = await agent.run(session.control, "reveal pricing");
    expect(outcome.success).toBe(true);
    expect(site.discoverUnlocked).toBe(true); // a click unlocks discovery in the mock
  });

  it("throws without an API key", () => {
    const prev = process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    try {
      expect(() => createOpenRouterComputerUseAgent()).toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (prev !== undefined) process.env["OPENROUTER_API_KEY"] = prev;
    }
  });
});

function makeRequest(): FastLaneRequest {
  return {
    checkpoint: {
      taskId: "task_or",
      agentId: "hermes",
      originalGoal: "Generate hero images.",
      failedToolCall: { id: "call_2", tool: "generate_image", arguments: { prompt: "hero #2" } },
      origin: { provider: PROVIDER, canonicalOrigin: ORIGIN, source: "task_configuration", lockedAt: new Date().toISOString() },
      failure: { type: "INSUFFICIENT_CREDITS", rawError: { status: 402 } },
    },
    quote: {
      provider: PROVIDER,
      purchase: { productId: "gen_5000_20", quantity: 1, credits: 5000, price: 20, currency: "USD" },
      billing: "one_time",
      autoRenew: false,
      reason: "needs credits",
    },
    requirement: { resource: "credits", amount: 3200 },
    mandate: {
      mandateId: "mnd_or",
      taskId: "task_or",
      origin: ORIGIN,
      provider: PROVIDER,
      productId: "gen_5000_20",
      maximumAmount: 50,
      currency: "USD",
      billingType: "one_time",
      autoRenew: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: "nonce_or",
      signature: "sig_ok",
    },
  };
}

describe("slow lane end-to-end with the OpenRouter fallback", () => {
  it("recovers a stuck discovery step via the OpenRouter agent", async () => {
    const site = new MockVendorSite({
      provider: PROVIDER,
      origin: ORIGIN,
      startingBalance: 0,
      failDiscoverUntilAssisted: true,
    });
    const agent = createOpenRouterComputerUseAgent({
      apiKey: "test-key",
      fetchImpl: fakeFetch(['{"action":"click","x":100,"y":200}', '{"action":"done","success":true}']),
    });
    const result = await runSlowLane(makeRequest(), {
      provider: new MockBrowserProvider(site),
      adapter: new GenericVendorAdapter({ provider: PROVIDER, origin: ORIGIN }),
      agent,
    });
    expect(result.verifiedEntitlement.balance).toBe(5000);
  });
});
