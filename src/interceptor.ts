import { classifyFailure } from "./classifier.js";
import type { AgentContext, FailureEvent } from "./event.js";
import { WakeUpManager } from "./wakeup-manager.js";

export interface ToolCallInfo {
  taskId: string;
  provider: string;
  toolName: string;
  toolArgs: unknown;
  context: AgentContext;
}

export class ErrorInterceptor {
  private wakeUpManager: WakeUpManager;

  constructor(wakeUpManager: WakeUpManager) {
    this.wakeUpManager = wakeUpManager;
  }

  async handleError(
    toolCall: ToolCallInfo,
    rawError: unknown,
  ): Promise<FailureEvent> {
    const classification = classifyFailure(rawError);

    const event: FailureEvent = {
      taskId: toolCall.taskId,
      provider: toolCall.provider,
      toolName: toolCall.toolName,
      toolArgs: toolCall.toolArgs,
      errorType: classification.classification,
      rawError,
      context: toolCall.context,
      timestamp: new Date().toISOString(),
    };

    await this.wakeUpManager.handle(event);

    return event;
  }
}