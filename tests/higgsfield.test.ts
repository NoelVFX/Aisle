import { describe, expect, it } from "vitest";
import { higgsfieldTool, type FetchLike } from "../src/gateway/upstreams.js";

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { forEach: (cb: (value: string, key: string) => void) => cb("application/json", "content-type") },
    text: async () => JSON.stringify(body),
  };
}

describe("higgsfield__generate_image", () => {
  it("submits, polls, and returns the generated image URL", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return calls.length === 1
        ? response(202, { request_id: "req_123" })
        : response(200, { status: "completed", images: [{ url: "https://cdn.example/red-bicycle.png" }] });
    };

    const tool = higgsfieldTool(
      {
        HIGGSFIELD_API_KEY_ID: "key_id",
        HIGGSFIELD_API_KEY_SECRET: "key_secret",
        HIGGSFIELD_API_URL: "https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard",
        HIGGSFIELD_POLL_INTERVAL_MS: "0",
      },
      fetchImpl,
    );

    const result = await tool.call({ prompt: "a red bicycle" });

    expect(result).toEqual({ ok: true, text: "Image ready: https://cdn.example/red-bicycle.png" });
    expect(calls[0]).toMatchObject({
      url: "https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard",
      method: "POST",
      headers: { Authorization: "Key key_id:key_secret" },
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ prompt: "a red bicycle" });
    expect(calls[1]).toMatchObject({
      url: "https://api.higgsfield.ai/requests/req_123/status",
      method: "GET",
    });
  });

  it("returns a credential error without making a request", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return response(500, {});
    };

    const result = await higgsfieldTool({}, fetchImpl).call({ prompt: "a red bicycle" });

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(called).toBe(false);
  });
});
