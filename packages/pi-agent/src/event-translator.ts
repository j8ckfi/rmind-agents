/**
 * Translate @mariozechner/pi-coding-agent AgentSessionEvent into the
 * UIMessageChunk shape the open-agents web UI already consumes.
 *
 * The web UI's chunk format (see apps/web/app/types.ts) is a superset of
 * the AI SDK's UIMessageStream — start / text / tool-call / tool-result /
 * data-* / finish. We intentionally project pi events into that shape so
 * apps/web does not need to know which agent backend is running.
 */

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { TurnUsage } from "./index";

export type UIMessageChunk =
  | { type: "start"; messageId?: string }
  | { type: "text"; text: string; messageId?: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
  | { type: "tool-update"; toolCallId: string; toolName: string; partial: unknown }
  | { type: "compaction"; reason: "manual" | "threshold" | "overflow"; phase: "start" | "end"; aborted?: boolean }
  | { type: "retry"; attempt: number; maxAttempts: number; delayMs?: number; phase: "start" | "end"; success?: boolean }
  | { type: "finish"; finishReason: "stop" | "tool_calls" | "abort"; usage?: TurnUsage };

export function translatePiEvent(event: AgentSessionEvent): UIMessageChunk[] {
  switch (event.type) {
    case "agent_start":
      return [{ type: "start" }];

    case "message_update": {
      // pi emits assistantMessageEvent of various shapes; we only forward text deltas here.
      // Tool deltas come through tool_execution_update.
      const ame = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
        .assistantMessageEvent;
      if (ame?.type === "text_delta" && typeof ame.delta === "string" && ame.delta.length > 0) {
        return [{ type: "text", text: ame.delta }];
      }
      return [];
    }

    case "tool_execution_start":
      return [
        {
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        },
      ];

    case "tool_execution_update":
      return [
        {
          type: "tool-update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partial: event.partialResult,
        },
      ];

    case "tool_execution_end":
      return [
        {
          type: "tool-result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        },
      ];

    case "compaction_start":
      return [{ type: "compaction", reason: event.reason, phase: "start" }];

    case "compaction_end":
      return [{ type: "compaction", reason: event.reason, phase: "end", aborted: event.aborted }];

    case "auto_retry_start":
      return [
        {
          type: "retry",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          phase: "start",
        },
      ];

    case "auto_retry_end":
      return [
        {
          type: "retry",
          attempt: event.attempt,
          maxAttempts: 0,
          phase: "end",
          success: event.success,
        },
      ];

    case "agent_end": {
      const usage = extractUsage(event);
      return [{ type: "finish", finishReason: "stop", usage }];
    }

    default:
      return [];
  }
}

function extractUsage(event: AgentSessionEvent): TurnUsage | undefined {
  // pi's agent_end carries the message list; usage is summed off the assistant messages.
  const messages = (event as { messages?: Array<Record<string, unknown>> }).messages;
  if (!Array.isArray(messages)) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  for (const msg of messages) {
    const usage = (msg as { usage?: Record<string, number> }).usage;
    if (!usage) continue;
    inputTokens += Number(usage.input ?? 0);
    outputTokens += Number(usage.output ?? 0);
    cacheReadTokens += Number(usage.cacheRead ?? 0);
    cacheWriteTokens += Number(usage.cacheWrite ?? 0);
    costUsd += Number(usage.cost ?? 0);
  }
  if (inputTokens === 0 && outputTokens === 0 && costUsd === 0) return undefined;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
}
