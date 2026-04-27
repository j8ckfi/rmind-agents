/**
 * @open-agents/pi-agent — wraps @mariozechner/pi-coding-agent so the rack can run
 * coding-agent turns against sandbox-backed tools and route per-turn across
 * OpenCode Go / Codex OAuth / Anthropic providers.
 *
 * Public entry point: runAgentTurn().
 */

import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import type { Sandbox } from "@open-agents/sandbox";
import { buildSandboxTools } from "./tools";
import { translatePiEvent, type UIMessageChunk } from "./event-translator";

export type { UIMessageChunk } from "./event-translator";
export { buildSandboxTools } from "./tools";

export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  toolResults?: Array<{ id: string; result: unknown; isError?: boolean }>;
}

export interface AgentModelSpec {
  /** Pi provider id, e.g. "opencode-go", "codex", "anthropic". */
  provider: string;
  /** Model id within the provider, e.g. "glm-5.1". */
  model: string;
  /** Optional thinking level forwarded to pi. */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface RunAgentTurnParams {
  taskId: string;
  sandbox: Sandbox;
  prompt: string;
  modelSpec: AgentModelSpec;
  history?: AgentMessage[];
  systemPrompt?: string;
  abortSignal?: AbortSignal;
  onEvent: (chunk: UIMessageChunk) => void | Promise<void>;
  /** Override path to pi auth.json (default: env PI_AUTH_PATH). */
  authPath?: string;
  /** Override path to pi models.json (default: env PI_MODELS_PATH). */
  modelsPath?: string;
}

export type AgentTurnResult =
  | { ok: true; finishReason: "stop" | "tool_calls" | "abort"; usage?: TurnUsage }
  | { ok: false; error: string; code: "auth" | "model_not_found" | "runtime" };

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

let cachedAuth: { path: string; storage: AuthStorage } | undefined;
let cachedRegistry: { path: string; auth: AuthStorage; registry: ModelRegistry } | undefined;

function getAuthStorage(authPath?: string): AuthStorage {
  const path = authPath ?? process.env.PI_AUTH_PATH ?? "";
  if (!cachedAuth || cachedAuth.path !== path) {
    cachedAuth = { path, storage: AuthStorage.create(path || undefined) };
  }
  return cachedAuth.storage;
}

function getModelRegistry(authPath?: string, modelsPath?: string): ModelRegistry {
  const auth = getAuthStorage(authPath);
  const path = modelsPath ?? process.env.PI_MODELS_PATH ?? "";
  if (!cachedRegistry || cachedRegistry.path !== path || cachedRegistry.auth !== auth) {
    cachedRegistry = { path, auth, registry: ModelRegistry.create(auth, path || undefined) };
  }
  return cachedRegistry.registry;
}

export async function runAgentTurn(params: RunAgentTurnParams): Promise<AgentTurnResult> {
  let registry: ModelRegistry;
  let auth: AuthStorage;
  try {
    auth = getAuthStorage(params.authPath);
    registry = getModelRegistry(params.authPath, params.modelsPath);
  } catch (err) {
    return { ok: false, code: "runtime", error: errorMessage(err) };
  }

  const model = registry.find(params.modelSpec.provider, params.modelSpec.model);
  if (!model) {
    return {
      ok: false,
      code: "model_not_found",
      error: `model ${params.modelSpec.provider}/${params.modelSpec.model} not in registry`,
    };
  }
  if (!registry.hasConfiguredAuth(model)) {
    return {
      ok: false,
      code: "auth",
      error: `provider ${params.modelSpec.provider} has no configured credentials; run \`pi auth login ${params.modelSpec.provider}\``,
    };
  }

  let session;
  try {
    const created = await createAgentSession({
      authStorage: auth,
      modelRegistry: registry,
      model,
      thinkingLevel: params.modelSpec.thinkingLevel,
      cwd: params.sandbox.workingDirectory,
      noTools: "builtin",
      // pi's ToolDefinition has narrower internal types for onUpdate (it expects
      // AgentToolResult<unknown>), but our shim ToolBundle treats updates as
      // opaque payloads — they get dropped at the UI layer in v1. Cast as
      // unknown[] so we don't drag pi-internal types into the public surface.
      customTools: buildSandboxTools(params.sandbox) as unknown as never[],
    });
    session = created.session;
  } catch (err) {
    return { ok: false, code: "runtime", error: errorMessage(err) };
  }

  let usage: TurnUsage | undefined;
  let finishReason: "stop" | "tool_calls" | "abort" = "stop";

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    const chunks = translatePiEvent(event);
    for (const chunk of chunks) {
      if (chunk.type === "finish") {
        finishReason = chunk.finishReason;
        if (chunk.usage) usage = chunk.usage;
      }
      void params.onEvent(chunk);
    }
  });

  try {
    if (params.abortSignal?.aborted) {
      finishReason = "abort";
    } else {
      await session.prompt(params.prompt, {
        signal: params.abortSignal,
        history: convertHistory(params.history),
        systemPrompt: params.systemPrompt,
      } as Parameters<typeof session.prompt>[1]);
    }
  } catch (err) {
    unsubscribe?.();
    if (params.abortSignal?.aborted) {
      return { ok: true, finishReason: "abort", usage };
    }
    return { ok: false, code: "runtime", error: errorMessage(err) };
  }
  unsubscribe?.();
  return { ok: true, finishReason, usage };
}

function convertHistory(history?: AgentMessage[]): unknown[] {
  if (!history?.length) return [];
  return history.map((msg) => ({
    role: msg.role,
    content: msg.content,
    toolCalls: msg.toolCalls,
    toolResults: msg.toolResults,
  }));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
