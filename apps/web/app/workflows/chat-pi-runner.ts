/**
 * Pi-coding-agent backend adapter for the chat workflow.
 *
 * Activated when `AGENT_BACKEND=pi`. Replaces the AI SDK ToolLoopAgent stream
 * with `@open-agents/pi-agent`'s `runAgentTurn`, projecting pi events into the
 * UIMessageChunk parts that the existing UI consumer expects.
 *
 * This is a best-effort projection in v1: text + tool-call + tool-result +
 * step boundaries are preserved; per-step usage/cost is reported once at
 * finish rather than per intermediate step. Cost tracking still works
 * because pi reports cumulative usage on agent_end.
 */

import { connectSandbox, type Sandbox, type SandboxState } from "@open-agents/sandbox";
import {
  runAgentTurn,
  type AgentMessage,
  type AgentModelSpec,
  type UIMessageChunk as PiUIMessageChunk,
} from "@open-agents/pi-agent";
import type { OpenAgentCallOptions } from "@open-agents/agent";
import type {
  WebAgentMessageMetadata,
  WebAgentStepFinishMetadata,
  WebAgentUIMessage,
} from "@/app/types";

export interface PiRunnerInput {
  messages: WebAgentUIMessage[];
  agentOptions: OpenAgentCallOptions;
  selectedModelId: string;
  modelId: string;
  abortSignal: AbortSignal;
  writable: WritableStream<unknown>;
  messageId: string;
  /**
   * Optional model spec override. When omitted, the runner parses
   * `selectedModelId` of the form "<provider>/<model>" — e.g.
   * "opencode-go/glm-5.1".
   */
  modelSpec?: AgentModelSpec;
}

export interface PiRunnerOutput {
  responseMessage: WebAgentUIMessage;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  totalCostUsd?: number;
  finishReason: "stop" | "tool_calls" | "abort";
}

export function isPiBackendEnabled(): boolean {
  return (process.env.AGENT_BACKEND ?? "").toLowerCase() === "pi";
}

function parseModelSpec(selectedModelId: string): AgentModelSpec {
  const idx = selectedModelId.indexOf("/");
  if (idx <= 0) return { provider: "opencode-go", model: selectedModelId };
  return { provider: selectedModelId.slice(0, idx), model: selectedModelId.slice(idx + 1) };
}

function extractSandboxState(options: OpenAgentCallOptions): SandboxState | undefined {
  // OpenAgentCallOptions carries the sandbox via experimental_context. The
  // workflow already loaded sandboxState from Postgres before calling us.
  const ctx = (options as unknown as { sandbox?: { state?: SandboxState } }).sandbox;
  return ctx?.state;
}

export async function runPiAgentStep(input: PiRunnerInput): Promise<PiRunnerOutput> {
  const sandboxState = extractSandboxState(input.agentOptions);
  if (!sandboxState) {
    throw new Error("pi-runner: no sandbox state in agentOptions");
  }
  const sandbox: Sandbox = await connectSandbox(sandboxState);
  const modelSpec = input.modelSpec ?? parseModelSpec(input.selectedModelId);
  const history = toHistory(input.messages);
  const lastUser = input.messages.findLast((m) => m.role === "user");
  const prompt = extractText(lastUser);

  const writer = input.writable.getWriter();
  let responseText = "";
  const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
  const toolResults: Array<{ id: string; result: unknown; isError?: boolean }> = [];
  let finishReason: "stop" | "tool_calls" | "abort" = "stop";
  let usage: PiRunnerOutput["usage"];
  let totalCostUsd: number | undefined;

  try {
    await writer.write({
      type: "start",
      messageId: input.messageId,
    } as unknown);
    await writer.write({ type: "start-step" } as unknown);

    const result = await runAgentTurn({
      taskId: input.messageId,
      sandbox,
      prompt,
      modelSpec,
      history,
      abortSignal: input.abortSignal,
      onEvent: async (chunk: PiUIMessageChunk) => {
        const projected = projectChunk(chunk, input.messageId);
        if (projected) await writer.write(projected as unknown);
        if (chunk.type === "text") {
          responseText += chunk.text;
        } else if (chunk.type === "tool-call") {
          toolCalls.push({ id: chunk.toolCallId, name: chunk.toolName, args: chunk.args });
        } else if (chunk.type === "tool-result") {
          toolResults.push({ id: chunk.toolCallId, result: chunk.result, isError: chunk.isError });
        } else if (chunk.type === "finish") {
          finishReason = chunk.finishReason;
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.inputTokens ?? 0,
              outputTokens: chunk.usage.outputTokens ?? 0,
              cacheReadTokens: chunk.usage.cacheReadTokens ?? 0,
              cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0,
            };
            totalCostUsd = chunk.usage.costUsd;
          }
        }
      },
    });

    if (!result.ok) {
      throw new Error(`pi-runner: ${result.code}: ${result.error}`);
    }

    const stepFinishReasons: WebAgentStepFinishMetadata[] = [
      { finishReason: mapFinishReason(finishReason), rawFinishReason: finishReason },
    ] as unknown as WebAgentStepFinishMetadata[];
    const usageShape = usage
      ? ({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
          reasoningTokens: 0,
          cachedInputTokens: usage.cacheReadTokens,
        } as unknown as WebAgentMessageMetadata["lastStepUsage"])
      : undefined;
    const metadata: WebAgentMessageMetadata = {
      selectedModelId: input.selectedModelId,
      modelId: input.modelId,
      lastStepUsage: usageShape,
      totalMessageUsage: usageShape,
      lastStepCost: totalCostUsd,
      totalMessageCost: totalCostUsd,
      lastStepFinishReason: mapFinishReason(finishReason) as WebAgentMessageMetadata["lastStepFinishReason"],
      lastStepRawFinishReason: finishReason,
      stepFinishReasons,
    };

    await writer.write({ type: "finish-step" } as unknown);
    await writer.write({ type: "finish" } as unknown);

    const responseMessage: WebAgentUIMessage = {
      id: input.messageId,
      role: "assistant",
      parts: assembleParts(responseText, toolCalls, toolResults),
      metadata,
    } as WebAgentUIMessage;

    return { responseMessage, usage, totalCostUsd, finishReason };
  } finally {
    writer.releaseLock();
  }
}

function projectChunk(chunk: PiUIMessageChunk, _messageId: string): unknown | undefined {
  switch (chunk.type) {
    case "text":
      return { type: "text-delta", delta: chunk.text };
    case "tool-call":
      return {
        type: "tool-input-available",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.args,
      };
    case "tool-result":
      return {
        type: "tool-output-available",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        output: chunk.result,
        isError: Boolean(chunk.isError),
      };
    case "tool-update":
      return undefined; // ignored at the UI layer in v1
    case "compaction":
    case "retry":
      return undefined; // observability events; not surfaced in chunks v1
    case "start":
    case "finish":
      return undefined; // emitted explicitly by the runner
    default:
      return undefined;
  }
}

function toHistory(messages: WebAgentUIMessage[]): AgentMessage[] {
  return messages.slice(0, -1).map((msg) => ({
    role: msg.role === "assistant" ? "assistant" : msg.role === "system" ? "system" : "user",
    content: extractText(msg),
  }));
}

function extractText(msg: WebAgentUIMessage | undefined): string {
  if (!msg) return "";
  const parts = (msg as { parts?: Array<{ type: string; text?: string }> }).parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

function assembleParts(
  text: string,
  toolCalls: Array<{ id: string; name: string; args: unknown }>,
  toolResults: Array<{ id: string; result: unknown; isError?: boolean }>,
): WebAgentUIMessage["parts"] {
  const parts: Array<Record<string, unknown>> = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const call of toolCalls) {
    const result = toolResults.find((r) => r.id === call.id);
    parts.push({
      type: `tool-${call.name}`,
      toolCallId: call.id,
      input: call.args,
      output: result?.result,
      state: result ? (result.isError ? "output-error" : "output-available") : "input-available",
    });
  }
  return parts as unknown as WebAgentUIMessage["parts"];
}

function mapFinishReason(reason: "stop" | "tool_calls" | "abort"): "stop" | "tool-calls" | "error" {
  if (reason === "tool_calls") return "tool-calls";
  if (reason === "abort") return "error";
  return "stop";
}
