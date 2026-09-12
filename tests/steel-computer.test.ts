import { describe, it, expect } from "vitest";
import { SteelComputerControl, createOpenRouterComputerUseAgent, type SteelComputerClient } from "../src/index.js";

function fakeSteel(error?: string) {
  const calls: Array<{ sessionId: string; body: Record<string, unknown> }> = [];
  const client: SteelComputerClient = {
    sessions: {
      computer: async (sessionId, body) => {
        calls.push({ sessionId, body });
        if (error) return { error };
        return body.action === "take_screenshot" ? { base64_image: Buffer.from("png-bytes").toString("base64") } : {};
      },
    },
  };
  return { client, calls };
}

describe("SteelComputerControl (sessions.computer executor)", () => {
  it("maps ControlSurface calls onto Steel computer actions", async () => {
    const { client, calls } = fakeSteel();
    const control = new SteelComputerControl(client, "sess_1", { width: 1280, height: 720 }, () => "https://shop.test/pricing");

    expect(Buffer.from(await control.screenshot()).toString()).toBe("png-bytes");
    await control.mouseClick(10.4, 20.6);
    await control.type("hello");
    await control.pressKey("Enter");
    await control.scroll(0, 300);

    expect(calls.map((c) => c.body)).toEqual([
      { action: "take_screenshot" },
      { action: "click_mouse", button: "left", coordinates: [10, 21] },
      { action: "type_text", text: "hello" },
      { action: "press_key", keys: ["Enter"] },
      { action: "scroll", coordinates: [640, 360], delta_x: 0, delta_y: 300 },
    ]);
    expect(calls.every((c) => c.sessionId === "sess_1")).toBe(true);
    expect(control.viewport()).toEqual({ width: 1280, height: 720 });
    expect(control.currentUrl()).toBe("https://shop.test/pricing");
  });

  it("surfaces Steel action errors instead of silently continuing", async () => {
    const { client } = fakeSteel("session not found");
    const control = new SteelComputerControl(client, "sess_x", { width: 1280, height: 720 }, () => "");
    await expect(control.mouseClick(1, 1)).rejects.toThrow(/session not found/);
  });

  it("runs the OpenRouter brain on the Steel executor", async () => {
    const { client, calls } = fakeSteel();
    const control = new SteelComputerControl(client, "sess_2", { width: 1280, height: 720 }, () => "");
    const replies = ['{"action":"click","x":100,"y":200}', '{"action":"done","success":true}'];
    let i = 0;
    const agent = createOpenRouterComputerUseAgent({
      apiKey: "infra-key",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: replies[i++] ?? "" } }] }),
      }),
    });
    const outcome = await agent.run(control, "reveal pricing");
    expect(outcome.success).toBe(true);
    expect(calls.some((c) => c.body["action"] === "click_mouse")).toBe(true);
  });
});
