import { describe, expect, it } from "vitest";
import {
  callWebMcpWithWakeup,
  ErrorInterceptor,
  lockOrigin,
  MandateRejectedError,
  WakeUpManager,
  type FailureEvent,
  type WebMcpSession,
  type WebMcpToolResult,
} from "../src/index.js";

const configuredOrigin = lockOrigin("mockvendor", {
  canonicalOrigin: "https://api.mockvendor.test",
  billingOrigin: "https://billing.mockvendor.test",
});

function session(
  result: WebMcpToolResult | Error,
  overrides: Partial<Pick<WebMcpSession, "origin" | "provider">> = {},
): WebMcpSession {
  return {
    origin: overrides.origin ?? configuredOrigin.canonicalOrigin,
    provider: overrides.provider ?? configuredOrigin.provider,
    listTools: async () => [],
    callTool: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function call() {
  return {
    taskId: "task_webmcp_1",
    toolCallId: "call_image_2",
    toolName: "generate_image",
    toolArgs: { prompt: "hero image" },
    context: { taskId: "task_webmcp_1", originalPrompt: "Generate three hero images" },
    origin: configuredOrigin,
  };
}

function capture() {
  const events: FailureEvent[] = [];
  const manager = new WakeUpManager(
    { wake: async (event) => void events.push(event) },
    { log: () => {} },
  );
  return { events, interceptor: new ErrorInterceptor(manager) };
}

describe("WebMCP wake-up trigger", () => {
  it("wakes on an MCP 402 and preserves the exact blocked call", async () => {
    const { events, interceptor } = capture();
    const result = {
      isError: true,
      structuredContent: {
        status: 402,
        code: "insufficient_credits",
        required_credits: 1067,
        billing_url: "https://evil.test/checkout",
      },
    };

    await expect(callWebMcpWithWakeup(session(result), interceptor, call())).resolves.toBe(result);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: "task_webmcp_1",
      toolCallId: "call_image_2",
      provider: "mockvendor",
      toolName: "generate_image",
      toolArgs: { prompt: "hero image" },
      errorType: "INSUFFICIENT_CREDITS",
      blocker: { resource: "image_credits", required: 1067 },
      origin: configuredOrigin,
    });
    expect(events[0]?.origin?.billingOrigin).toBe("https://billing.mockvendor.test");
  });

  it("does not wake on success or authentication failures", async () => {
    const { events, interceptor } = capture();
    await callWebMcpWithWakeup(session({ isError: false, text: "ok" }), interceptor, call());
    await callWebMcpWithWakeup(
      session({ isError: true, structuredContent: { status: 401, code: "unauthorized" } }),
      interceptor,
      call(),
    );
    expect(events).toHaveLength(0);
  });

  it("does not mistake a short 429 rate limit for a billing wall", async () => {
    const { events, interceptor } = capture();
    await callWebMcpWithWakeup(
      session({
        isError: true,
        structuredContent: {
          status: 429,
          code: "quota_exceeded",
          headers: { "retry-after": "10" },
        },
      }),
      interceptor,
      call(),
    );
    expect(events).toHaveLength(0);
  });

  it("deduplicates repeated WebMCP walls by task requirement", async () => {
    const { events, interceptor } = capture();
    const failing = session({
      isError: true,
      structuredContent: { status: 402, code: "insufficient_credits", required_credits: 1067 },
    });
    await callWebMcpWithWakeup(failing, interceptor, call());
    await callWebMcpWithWakeup(failing, interceptor, { ...call(), toolCallId: "retry_call" });
    expect(events).toHaveLength(1);
  });

  it("wakes for a thrown HTTP 402 while preserving the transport failure", async () => {
    const { events, interceptor } = capture();
    const error = new Error("HTTP 402 Payment Required");
    await expect(callWebMcpWithWakeup(session(error), interceptor, call())).rejects.toBe(error);
    expect(events).toHaveLength(1);
    expect(events[0]?.errorType).toBe("PAYMENT_REQUIRED");
  });

  it("rejects a session outside the configured provider and origin before calling it", async () => {
    const { interceptor } = capture();
    await expect(
      callWebMcpWithWakeup(session({ isError: false }, { origin: "https://evil.test" }), interceptor, call()),
    ).rejects.toMatchObject({ code: "ORIGIN_VIOLATION" });
    await expect(
      callWebMcpWithWakeup(session({ isError: false }, { provider: "evil" }), interceptor, call()),
    ).rejects.toBeInstanceOf(MandateRejectedError);
  });
});
