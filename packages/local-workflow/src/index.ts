/**
 * `workflow` module — drop-in replacement for the workflow primitive surface.
 * Re-exports the shim runtime; the npm `workflow@^4` package is shadowed by
 * this workspace package because `name: "workflow"` resolves locally first.
 */

import {
  getCurrentMetadata,
  getCurrentWritable,
  type WorkflowMetadata,
  type StepMetadata,
} from "./runtime";

export type { WorkflowMetadata, StepMetadata } from "./runtime";

export class FatalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FatalError";
  }
}

export class RetryableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableError";
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function getWorkflowMetadata(): WorkflowMetadata {
  const md = getCurrentMetadata();
  if (!md) {
    throw new Error("workflow.getWorkflowMetadata() called outside of a running workflow");
  }
  return md;
}

export function getStepMetadata(): StepMetadata {
  const md = getCurrentMetadata();
  if (!md) {
    throw new Error("workflow.getStepMetadata() called outside of a running workflow");
  }
  return { stepId: md.runId, attempt: md.attempt };
}

export function getWritable<T = unknown>(): WritableStream<T> {
  return getCurrentWritable<T>();
}

/** Identity passthrough; the live network is fine without durable retries here. */
export const fetch = globalThis.fetch.bind(globalThis);

export type HookId = string;
export type WebhookId = string;

/** Stub: hooks are not used by the rack runtime. Returning a placeholder ID is enough for type compatibility. */
export function createHook<T = unknown>(_options?: unknown): { id: HookId; readable: ReadableStream<T> } {
  return {
    id: `hook_${Date.now().toString(36)}`,
    readable: new ReadableStream<T>({ start(controller) { controller.close(); } }),
  };
}

export function createWebhook(_options?: unknown): { id: WebhookId; url: string } {
  return { id: `webhook_${Date.now().toString(36)}`, url: "about:blank" };
}
