/**
 * Process-local workflow runtime — replaces @vercel/workflow with an in-process
 * registry of long-running async functions. Each run owns a TransformStream so
 * the agent can `getWritable()` while the HTTP route can `getRun(id).getReadable()`.
 *
 * Durability: this v1 is in-memory. A rack reboot kills in-flight runs. The
 * application persists every emitted UIMessageChunk into Postgres via the
 * existing `persistAssistantMessage` step, so a reconnect after restart can
 * still replay history through chats.activeStreamId logic; only the live
 * stream of an interrupted run is lost. Future work: pipe chunks through a
 * Postgres-backed buffer so warm reconnects survive restarts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface WorkflowMetadata {
  /** Stable identifier for the run. Aliased as `workflowRunId` for compatibility with @vercel/workflow callers. */
  runId: string;
  /** @deprecated alias of runId; preserved so existing destructure `{ workflowRunId }` keeps compiling. */
  workflowRunId: string;
  attempt: number;
  workflowName?: string;
  startedAt: number;
}

export interface StepMetadata {
  stepId: string;
  attempt: number;
}

interface BufferedChunk<T> {
  data: T;
  index: number;
}

/** Run status — mirrors the @vercel/workflow surface so callers can keep using the same enum. */
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface RunHandle<T = unknown> {
  runId: string;
  status: RunStatus;
  getReadable<U = T>(): ReadableStream<U>;
  getReadableFromIndex<U = T>(startIndex: number): ReadableStream<U>;
  abort(reason?: unknown): void;
  cancel(reason?: unknown): Promise<void>;
  getResult(): Promise<unknown>;
  getError(): unknown;
}

interface RunRecord<T> extends Omit<RunHandle<T>, "getReadable" | "getReadableFromIndex" | "getResult" | "getError" | "cancel"> {
  buffer: BufferedChunk<T>[];
  subscribers: Set<{ enqueue: (chunk: BufferedChunk<T>) => void; close: () => void; error: (err: unknown) => void }>;
  writable: WritableStream<T>;
  metadata: WorkflowMetadata;
  abortController: AbortController;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  resultPromise: Promise<unknown>;
  resultValue: unknown;
  resultError: unknown;
}

interface ContextStore {
  runId: string;
  metadata: WorkflowMetadata;
  record: RunRecord<unknown>;
}

const runs = new Map<string, RunRecord<unknown>>();
const ctx = new AsyncLocalStorage<ContextStore>();

function makeRecord<T>(runId: string, workflowName?: string): RunRecord<T> {
  const subscribers: RunRecord<T>["subscribers"] = new Set();
  const buffer: BufferedChunk<T>[] = [];
  let writeIndex = 0;
  const writable = new WritableStream<T>({
    write(chunk) {
      const entry = { data: chunk, index: writeIndex };
      writeIndex += 1;
      buffer.push(entry);
      for (const sub of subscribers) {
        try {
          sub.enqueue(entry);
        } catch {
          // ignore failed subscriber
        }
      }
    },
    close() {
      for (const sub of subscribers) {
        try {
          sub.close();
        } catch {
          // ignore
        }
      }
    },
    abort(reason) {
      for (const sub of subscribers) {
        try {
          sub.error(reason);
        } catch {
          // ignore
        }
      }
    },
  });
  let resolveResult!: (value: unknown) => void;
  let rejectResult!: (reason: unknown) => void;
  const resultPromise = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const record: RunRecord<T> = {
    runId,
    status: "pending",
    buffer,
    subscribers,
    writable,
    metadata: {
      runId,
      workflowRunId: runId,
      attempt: 1,
      workflowName,
      startedAt: Date.now(),
    },
    abortController: new AbortController(),
    resolve: (v) => {
      record.resultValue = v;
      resolveResult(v);
    },
    reject: (e) => {
      record.resultError = e;
      rejectResult(e);
    },
    resultPromise,
    resultValue: undefined,
    resultError: undefined,
    abort(reason) {
      if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") return;
      record.status = "cancelled";
      try {
        record.abortController.abort(reason);
      } catch {
        // ignore
      }
      void record.writable.abort(reason).catch(() => undefined);
      record.reject(reason ?? new Error("aborted"));
    },
  };
  return record;
}

function buildReadable<T>(record: RunRecord<T>, startIndex: number): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      const replay = record.buffer.filter((entry) => entry.index >= startIndex);
      for (const entry of replay) controller.enqueue(entry.data);
      if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
        if (record.status === "failed") controller.error(record.resultError);
        else if (record.status === "cancelled") controller.error(record.resultError ?? new Error("aborted"));
        else controller.close();
        return;
      }
      const sub = {
        enqueue: (chunk: BufferedChunk<T>) => controller.enqueue(chunk.data),
        close: () => controller.close(),
        error: (err: unknown) => controller.error(err),
      };
      record.subscribers.add(sub);
    },
    cancel() {
      // subscriber set is cleared lazily; controller close drops references
    },
  });
}

export function startWorkflow<TArgs extends unknown[], TResult>(
  workflow: (...args: TArgs) => Promise<TResult>,
  args: TArgs,
  options?: { workflowName?: string; runId?: string },
): RunHandle<unknown> {
  const runId = options?.runId ?? randomUUID();
  const record = makeRecord<unknown>(runId, options?.workflowName ?? workflow.name);
  runs.set(runId, record);

  const handle: RunHandle<unknown> = {
    runId,
    get status() {
      return record.status;
    },
    getReadable<U = unknown>() {
      return buildReadable(record, 0) as unknown as ReadableStream<U>;
    },
    getReadableFromIndex<U = unknown>(startIndex: number) {
      return buildReadable(record, startIndex) as unknown as ReadableStream<U>;
    },
    abort(reason?: unknown) {
      record.abort(reason);
    },
    cancel(reason?: unknown) {
      record.abort(reason);
      return Promise.resolve();
    },
    getResult() {
      return record.resultPromise;
    },
    getError() {
      return record.resultError;
    },
  };

  // Run the workflow inside AsyncLocalStorage so getWritable() / getWorkflowMetadata() resolve.
  queueMicrotask(() => {
    record.status = "running";
    ctx.run(
      { runId, metadata: record.metadata, record },
      async () => {
        try {
          const result = await workflow(...args);
          record.resolve(result);
          record.status = "completed";
          await record.writable.close().catch(() => undefined);
        } catch (err) {
          record.reject(err);
          record.status = "failed";
          await record.writable.abort(err).catch(() => undefined);
        }
      },
    );
  });

  return handle;
}

export function getRunHandle(runId: string): RunHandle<unknown> | undefined {
  const record = runs.get(runId);
  if (!record) return undefined;
  return {
    runId,
    get status() {
      return record.status;
    },
    getReadable<U = unknown>() {
      return buildReadable(record, 0) as unknown as ReadableStream<U>;
    },
    getReadableFromIndex<U = unknown>(startIndex: number) {
      return buildReadable(record, startIndex) as unknown as ReadableStream<U>;
    },
    abort(reason?: unknown) {
      record.abort(reason);
    },
    cancel(reason?: unknown) {
      record.abort(reason);
      return Promise.resolve();
    },
    getResult() {
      return record.resultPromise;
    },
    getError() {
      return record.resultError;
    },
  };
}

export function getCurrentRunId(): string | undefined {
  return ctx.getStore()?.runId;
}

export function getCurrentMetadata(): WorkflowMetadata | undefined {
  return ctx.getStore()?.metadata;
}

export function getCurrentWritable<T = unknown>(): WritableStream<T> {
  const store = ctx.getStore();
  if (!store) throw new Error("workflow.getWritable() called outside of a running workflow");
  return store.record.writable as WritableStream<T>;
}

/** Reaper for completed runs. The host should call this periodically. */
export function reapFinishedRuns(maxAgeMs = 60 * 60 * 1000): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, record] of runs) {
    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled") {
      if (now - record.metadata.startedAt > maxAgeMs) {
        runs.delete(id);
        removed += 1;
      }
    }
  }
  return removed;
}
