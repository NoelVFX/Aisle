import { describe, it, expect } from "vitest";
import { recommendTool } from "../src/agnic/recommend.js";
import type { OpenRouterFetch } from "../src/slow-lane/computer-use.js";

/** A scripted OpenRouter chat endpoint: handler(payload, attempt) → {ok,status,content}. */
function mockOR(handler: (payload: Record<string, unknown>, attempt: number) => { ok?: boolean; status?: number; content?: string; model?: string }): {
  fetchImpl: OpenRouterFetch;
  calls: Array<{ model: unknown; models: unknown; body: Record<string, unknown> }>;
} {
  const calls: Array<{ model: unknown; models: unknown; body: Record<string, unknown> }> = [];
  const fetchImpl: OpenRouterFetch = async (_url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ model: body["model"], models: body["models"], body });
    const r = handler(body, calls.length - 1);
    const ok = r.ok ?? true;
    const status = r.status ?? (ok ? 200 : 500);
    const payload = JSON.stringify({ model: r.model ?? body["model"], choices: [{ message: { content: r.content ?? "" } }] });
    return { ok, status, text: async () => payload };
  };
  return { fetchImpl, calls };
}

const resendReply = JSON.stringify({
  tool_name: "Resend",
  vendor: "Resend",
  category: "Transactional email API",
  why: "Developer-first email with an official MCP server",
  checkout_url: "https://resend.com/pricing",
  has_mcp: true,
  alternatives: [{ tool_name: "Postmark", why: "Reliable transactional email" }, { tool_name: "SendGrid", why: "Scales to volume" }],
});

describe("recommendTool", () => {
  it("returns a structured recommendation with a usable checkout URL", async () => {
    const { fetchImpl, calls } = mockOR(() => ({ content: resendReply, model: "qwen/qwen3.7-max" }));
    const rec = await recommendTool("an MCP tool for my site that sends email autonomously", { apiKey: "k", fetchImpl });
    expect(rec.tool_name).toBe("Resend");
    expect(rec.checkout_url).toBe("https://resend.com/pricing");
    expect(rec.has_mcp).toBe(true);
    expect(rec.alternatives.map((a) => a.tool_name)).toEqual(["Postmark", "SendGrid"]);
    expect(rec.model_used).toBe("qwen/qwen3.7-max");
    // Sends the primary model + the fallback chain in `models`.
    expect(calls[0]?.model).toBe("qwen/qwen3.7-max");
    expect(Array.isArray(calls[0]?.models)).toBe(true);
  });

  it("passes plan_hint through when the model names a plan, and asks for it in the prompt", async () => {
    const withHint = JSON.stringify({ ...JSON.parse(resendReply), plan_hint: "  Pro (~$20/month)  " });
    const { fetchImpl, calls } = mockOR(() => ({ content: withHint }));
    const rec = await recommendTool("send email", { apiKey: "k", fetchImpl });
    expect(rec.plan_hint).toBe("Pro (~$20/month)");
    const messages = calls[0]?.body["messages"] as Array<{ content: string }>;
    expect(messages[0]?.content).toContain("plan_hint");
  });

  it("omits plan_hint when the model leaves it out, blank, or not a string", async () => {
    for (const hint of [undefined, "", "   ", 42, { name: "Pro" }]) {
      const reply = JSON.stringify({ ...JSON.parse(resendReply), ...(hint === undefined ? {} : { plan_hint: hint }) });
      const { fetchImpl } = mockOR(() => ({ content: reply }));
      const rec = await recommendTool("send email", { apiKey: "k", fetchImpl });
      expect(rec.plan_hint).toBeUndefined();
      expect("plan_hint" in rec).toBe(false);
    }
  });

  it("tolerates markdown fences and prose around the JSON", async () => {
    const { fetchImpl } = mockOR(() => ({ content: "Sure!\n```json\n" + resendReply + "\n```\nHope that helps." }));
    const rec = await recommendTool("send email", { apiKey: "k", fetchImpl });
    expect(rec.tool_name).toBe("Resend");
  });

  it("flags a non-URL checkout so the agent confirms before buying", async () => {
    const { fetchImpl } = mockOR(() => ({ content: JSON.stringify({ tool_name: "Resend", checkout_url: "resend dot com" }) }));
    const rec = await recommendTool("email", { apiKey: "k", fetchImpl });
    expect(rec.url_warning).toBeTruthy();
  });

  it("advances to a fallback model on HTTP error, then succeeds", async () => {
    const { fetchImpl, calls } = mockOR((_p, attempt) => (attempt === 0 ? { ok: false, status: 429 } : { content: resendReply, model: "qwen/qwen3.8-max-0902" }));
    const rec = await recommendTool("email", { apiKey: "k", fetchImpl });
    expect(rec.tool_name).toBe("Resend");
    expect(rec.model_used).toBe("qwen/qwen3.8-max-0902");
    expect(calls.length).toBe(2);
    expect(calls[1]?.model).toBe("qwen/qwen3.8-max-0902");
  });

  it("throws with the last error when every model fails", async () => {
    const { fetchImpl } = mockOR(() => ({ content: "not json at all" }));
    await expect(recommendTool("email", { apiKey: "k", fetchImpl })).rejects.toThrow(/RECOMMEND_BAD_REPLY/);
  });

  it("requires a goal and a key", async () => {
    const { fetchImpl } = mockOR(() => ({ content: resendReply }));
    await expect(recommendTool("   ", { apiKey: "k", fetchImpl })).rejects.toThrow(/EMPTY_GOAL/);
    await expect(recommendTool("email", { apiKey: "", fetchImpl })).rejects.toThrow(/OPENROUTER_INFRA_KEY/);
  });
});
