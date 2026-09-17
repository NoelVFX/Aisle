/**
 * Task-facing WebMCP call wrapper.
 *
 * It turns an MCP tool error into the same FailureEvent used by the gateway
 * wake-up path. It does not purchase, approve, or replay anything itself.
 */

import { MandateRejectedError } from "../errors.js";
import type { AgentContext } from "../event.js";
import { ErrorInterceptor } from "../interceptor.js";
import { sameOrigin } from "../policy/policy.js";
import type { LockedOrigin } from "../types.js";
import type { WebMcpSession, WebMcpToolResult } from "./session.js";

export interface WebMcpWakeupCall {
  taskId: string;
  toolCallId?: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  context: AgentContext;
  /** Trusted origin from upstream configuration or an enrollment row. */
  origin: LockedOrigin;
  /** Optional hash of the credential used by this call. Never pass the key. */
  credentialFingerprint?: string;
}

/**
 * Execute a task tool and wake Aisle if WebMCP reports a billing wall.
 * The original MCP result or thrown transport error is preserved for the host.
 */
export async function callWebMcpWithWakeup(
  session: WebMcpSession,
  interceptor: ErrorInterceptor,
  call: WebMcpWakeupCall,
): Promise<WebMcpToolResult> {
  assertConfiguredSession(session, call.origin);

  const base = {
    taskId: call.taskId,
    provider: session.provider,
    toolName: call.toolName,
    toolArgs: call.toolArgs,
    context: call.context,
    origin: call.origin,
    ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
    ...(call.credentialFingerprint === undefined
      ? {}
      : { credentialFingerprint: call.credentialFingerprint }),
  };

  let result: WebMcpToolResult;
  try {
    result = await session.callTool(call.toolName, call.toolArgs);
  } catch (error) {
    await interceptor.handleError(base, error);
    throw error;
  }

  if (result.isError) {
    const rawError = errorPayload(result);
    await interceptor.handleError(
      { ...base, bodyAvailable: rawError.bodyAvailable },
      rawError.value,
    );
  }

  return result;
}

function assertConfiguredSession(session: WebMcpSession, origin: LockedOrigin): void {
  if (session.provider !== origin.provider) {
    throw new MandateRejectedError(
      `WebMCP provider '${session.provider}' does not match configured provider '${origin.provider}'.`,
      "PROVIDER_MISMATCH",
    );
  }
  if (![origin.canonicalOrigin, origin.billingOrigin].some((allowed) => sameOrigin(session.origin, allowed))) {
    throw new MandateRejectedError(
      `WebMCP origin '${session.origin}' is not authorized by task configuration.`,
      "ORIGIN_VIOLATION",
    );
  }
}

function errorPayload(result: WebMcpToolResult): { value: unknown; bodyAvailable: boolean } {
  if (result.structuredContent !== undefined) {
    return { value: { isError: true, ...result.structuredContent }, bodyAvailable: true };
  }
  if (result.text !== undefined && result.text.trim() !== "") {
    try {
      return { value: JSON.parse(result.text), bodyAvailable: true };
    } catch {
      return { value: result.text, bodyAvailable: true };
    }
  }
  return { value: { isError: true }, bodyAvailable: false };
}
