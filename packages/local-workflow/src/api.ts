/**
 * `workflow/api` module — drop-in replacement for the API surface.
 * `start(fn, ...args)` returns a run handle whose runId can be persisted to
 * `chats.activeStreamId`. `getRun(id)` looks up an in-flight run for streaming.
 */

import { startWorkflow, getRunHandle, type RunHandle } from "./runtime";

export type { RunHandle };

export interface StartOptions {
  /** Optional explicit runId; defaults to randomUUID(). */
  runId?: string;
  /** Optional workflow name for logs. */
  workflowName?: string;
}

export function start<TArgs extends unknown[], TResult>(
  workflow: (...args: TArgs) => Promise<TResult>,
  ...args: TArgs
): RunHandle<unknown>;
export function start<TArgs extends unknown[], TResult>(
  options: StartOptions,
  workflow: (...args: TArgs) => Promise<TResult>,
  ...args: TArgs
): RunHandle<unknown>;
export function start(...inputs: unknown[]): RunHandle<unknown> {
  if (typeof inputs[0] === "function") {
    const [workflow, ...args] = inputs as [(...a: unknown[]) => Promise<unknown>, ...unknown[]];
    return startWorkflow(workflow, args, { workflowName: workflow.name });
  }
  const [options, workflow, ...args] = inputs as [
    StartOptions,
    (...a: unknown[]) => Promise<unknown>,
    ...unknown[],
  ];
  return startWorkflow(workflow, args, { ...options });
}

export function getRun(runId: string): RunHandle<unknown> {
  const handle = getRunHandle(runId);
  if (!handle) {
    // Match @vercel/workflow's behaviour: return a synthetic "not found" handle
    // whose readable stream errors immediately so callers can tell the run is gone.
    return {
      runId,
      status: "failed",
      getReadable() {
        return new ReadableStream({
          start(controller) {
            controller.error(new Error(`workflow run ${runId} not found`));
          },
        });
      },
      getReadableFromIndex() {
        return new ReadableStream({
          start(controller) {
            controller.error(new Error(`workflow run ${runId} not found`));
          },
        });
      },
      abort() {
        // no-op
      },
      getResult() {
        return Promise.reject(new Error(`workflow run ${runId} not found`));
      },
      getError() {
        return new Error(`workflow run ${runId} not found`);
      },
    };
  }
  return handle;
}

export function resumeHook<T = unknown>(_hookId: string, _value?: T): Promise<void> {
  // Hooks are stubbed — see ./index.ts createHook. resumeHook is a no-op so existing
  // call sites compile, but the rack does not depend on this primitive.
  return Promise.resolve();
}

export function resumeWebhook<T = unknown>(_webhookId: string, _value?: T): Promise<void> {
  return Promise.resolve();
}
