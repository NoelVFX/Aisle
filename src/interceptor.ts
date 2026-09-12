import { classifyFailure } from "./classifier.js";
import type { LockedOrigin } from "./types.js";
import type { AgentContext, FailureEvent } from "./event.js";
import { WakeUpManager } from "./wakeup-manager.js";

export interface ToolCallInfo {
  taskId: string;
  toolCallId?: string;
  /** Upstream namespace from config. Selects vendor classifier rules. */
  provider: string;
  toolName: string;
  toolArgs: unknown;
  context: AgentContext;
  /** Origin from upstreams.json / enrollment. NEVER derived from the error. */
  origin?: LockedOrigin;
  /** sha256 of the API key used, so infra keys are never recovered (§16.5). */
  credentialFingerprint?: string;
  /** false when the response body was unavailable (web path, evicted). */
  bodyAvailable?: boolean;
}

/**
 * Connects a raw tool/provider error to the wake-up system:
 * raw error → normalize + classify → FailureEvent → WakeUpManager.
 * The interceptor does not purchase anything.
 */
export class ErrorInterceptor {
  constructor(private readonly wakeUpManager: WakeUpManager) {}

  async handleError(toolCall: ToolCallInfo, rawError: unknown): Promise<FailureEvent> {
    const classified = classifyFailure(rawError, {
      provider: toolCall.provider,
      ...(toolCall.bodyAvailable === undefined ? {} : { bodyAvailable: toolCall.bodyAvailable }),
    });

    const event: FailureEvent = {
      taskId: toolCall.taskId,
      provider: toolCall.provider,
      toolName: toolCall.toolName,
      toolArgs: toolCall.toolArgs,
      errorType: classified.classification,
      blocker: classified.blocker,
      rawError,
      context: toolCall.context,
      timestamp: new Date().toISOString(),
    };
    if (toolCall.toolCallId !== undefined) event.toolCallId = toolCall.toolCallId;
    if (toolCall.origin !== undefined) event.origin = toolCall.origin;
    if (toolCall.credentialFingerprint !== undefined) event.credentialFingerprint = toolCall.credentialFingerprint;

    await this.wakeUpManager.handle(event);
    return event;
  }
}
