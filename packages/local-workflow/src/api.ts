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

/**
 * Start a workflow run.
 *
 * Two call shapes are supported to match @vercel/workflow:
 *   - start(workflow, [arg1, arg2, ...])
 *   - start(options, workflow, [arg1, arg2, ...])
 * The args list is passed as a single array argument (matching the rack's
 * existing call sites), not as a varargs spread.
 */
export function start<TArgs extends unknown[], TResult>(
  workflow: (...args: TArgs) => Promise<TResult>,
  args?: TArgs,
): Promise<RunHandle<unknown>>;
export function start<TArgs extends unknown[], TResult>(
  options: StartOptions,
  workflow: (...args: TArgs) => Promise<TResult>,
  args?: TArgs,
): Promise<RunHandle<unknown>>;
export function start(...inputs: unknown[]): Promise<RunHandle<unknown>> {
  if (typeof inputs[0] === "function") {
    const workflow = inputs[0] as (...a: unknown[]) => Promise<unknown>;
    const args = (inputs[1] as unknown[] | undefined) ?? [];
    return Promise.resolve(startWorkflow(workflow, args, { workflowName: workflow.name }));
  }
  const options = inputs[0] as StartOptions;
  const workflow = inputs[1] as (...a: unknown[]) => Promise<unknown>;
  const args = (inputs[2] as unknown[] | undefined) ?? [];
  return Promise.resolve(startWorkflow(workflow, args, { ...options }));
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
      cancel() {
        return Promise.resolve();
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
