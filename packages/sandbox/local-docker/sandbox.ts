/**
 * LocalDockerSandbox — implements the @open-agents/sandbox Sandbox interface backed by a
 * single docker container per task. Drives the container with `docker exec` for shell ops
 * and `tar` archives for file I/O so we never depend on shell quoting.
 */

import type { Dirent } from "fs";
import path from "path";
import { Buffer } from "buffer";
import { Readable, Writable } from "stream";
import Docker from "dockerode";
import * as tar from "tar-stream";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
  SandboxType,
  SnapshotResult,
} from "../interface";
import { LOCAL_DOCKER_DEFAULTS } from "./config";
import type { LocalDockerState } from "./state";

const SANDBOX_TYPE: SandboxType = "cloud";

interface ExecHandle {
  pid?: number;
  stop: () => Promise<void>;
}

export interface LocalDockerSandboxParams {
  state: LocalDockerState;
  docker: Docker;
  container: Docker.Container;
  hooks?: SandboxHooks;
  env?: Record<string, string>;
  currentBranch?: string;
}

export class LocalDockerSandbox implements Sandbox {
  readonly type: SandboxType = SANDBOX_TYPE;
  readonly hooks?: SandboxHooks;
  readonly env?: Record<string, string>;

  private readonly docker: Docker;
  private readonly container: Docker.Container;
  private readonly state: LocalDockerState;
  private readonly activeExecs = new Set<ExecHandle>();
  private stopped = false;
  private currentBranchInternal?: string;

  constructor(params: LocalDockerSandboxParams) {
    this.docker = params.docker;
    this.container = params.container;
    this.state = params.state;
    this.hooks = params.hooks;
    this.env = params.env;
    this.currentBranchInternal = params.currentBranch ?? params.state.branch;
  }

  get workingDirectory(): string {
    return this.state.workingDirectory;
  }

  get currentBranch(): string | undefined {
    return this.currentBranchInternal;
  }

  get host(): string | undefined {
    return this.state.host;
  }

  get expiresAt(): number | undefined {
    return this.state.expiresAt;
  }

  get timeout(): number | undefined {
    return this.state.timeoutMs;
  }

  get environmentDetails(): string | undefined {
    return [
      `Sandbox: local-docker (${this.state.baseImage})`,
      `Working directory: ${this.workingDirectory}`,
      this.currentBranch ? `Current branch: ${this.currentBranch}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // ---------- file ops ----------

  async readFile(filePath: string, _encoding: "utf-8"): Promise<string> {
    this.assertAlive();
    const absolute = this.absolute(filePath);
    const stream = await this.container.getArchive({ path: absolute });
    const file = await extractFirstFile(stream);
    if (file === null) {
      throw new Error(`readFile: no file at ${absolute}`);
    }
    return file.toString("utf-8");
  }

  async writeFile(filePath: string, content: string, _encoding: "utf-8"): Promise<void> {
    this.assertAlive();
    const absolute = this.absolute(filePath);
    const dir = path.posix.dirname(absolute);
    await this.mkdir(dir, { recursive: true });
    const archive = makeSingleFileArchive(path.posix.basename(absolute), content);
    await this.container.putArchive(archive, { path: dir });
  }

  async stat(filePath: string): Promise<SandboxStats> {
    this.assertAlive();
    const absolute = this.absolute(filePath);
    // Pass the path as a separate argv element — no shell interpolation, no
    // quoting hazards from special characters in paths.
    const result = await this.execRaw(
      ["stat", "-c", "%F|%s|%Y", "--", absolute],
      this.workingDirectory,
      LOCAL_DOCKER_DEFAULTS.execTimeoutMs,
    );
    if (!result.success || result.exitCode !== 0) {
      throw new Error(`stat: ${absolute}: ${result.stderr.trim() || "not found"}`);
    }
    const [kind, size, mtime] = result.stdout.trim().split("|");
    return {
      isDirectory: () => kind === "directory",
      isFile: () => kind === "regular file" || kind === "regular empty file",
      size: Number(size ?? 0),
      mtimeMs: Number(mtime ?? 0) * 1000,
    };
  }

  async access(filePath: string): Promise<void> {
    this.assertAlive();
    const absolute = this.absolute(filePath);
    const result = await this.execRaw(
      ["test", "-e", absolute],
      this.workingDirectory,
      LOCAL_DOCKER_DEFAULTS.execTimeoutMs,
    );
    if (!result.success || result.exitCode !== 0) {
      throw new Error(`access: ${absolute}: ENOENT`);
    }
  }

  async mkdir(filePath: string, options?: { recursive?: boolean }): Promise<void> {
    this.assertAlive();
    const absolute = this.absolute(filePath);
    const argv = options?.recursive ? ["mkdir", "-p", "--", absolute] : ["mkdir", "--", absolute];
    const result = await this.execRaw(
      argv,
      this.workingDirectory,
      LOCAL_DOCKER_DEFAULTS.execTimeoutMs,
    );
    if (!result.success || result.exitCode !== 0) {
      throw new Error(`mkdir ${absolute}: ${result.stderr.trim()}`);
    }
  }

  async readdir(filePath: string, _options: { withFileTypes: true }): Promise<Dirent[]> {
    this.assertAlive();
    const absolute = this.absolute(filePath);
    const result = await this.execRaw(
      ["find", absolute, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f|%y\n"],
      this.workingDirectory,
      LOCAL_DOCKER_DEFAULTS.execTimeoutMs,
    );
    if (!result.success || result.exitCode !== 0) {
      throw new Error(`readdir ${absolute}: ${result.stderr.trim()}`);
    }
    const lines = result.stdout.split("\n").filter((line) => line.length > 0);
    return lines.map((line) => {
      const [name, kind] = line.split("|");
      return makeDirent(name ?? "", kind ?? "f");
    });
  }

  // ---------- execution ----------

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    this.assertAlive();
    return this.execShell(command, cwd, timeoutMs, options?.signal);
  }

  async execDetached(command: string, cwd: string): Promise<{ commandId: string }> {
    this.assertAlive();
    const exec = await this.container.exec({
      Cmd: ["sh", "-lc", command],
      User: this.state.user,
      WorkingDir: cwd,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
    });
    await exec.start({ Detach: true, Tty: false });
    return { commandId: exec.id };
  }

  // ---------- lifecycle ----------

  domain(port: number): string {
    const hostPort = this.state.portMap[port] ?? port;
    return `http://${this.state.host}:${hostPort}`;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await Promise.allSettled(Array.from(this.activeExecs).map((handle) => handle.stop()));
      this.activeExecs.clear();
      await this.hooks?.beforeStop?.(this);
      await this.container.remove({ force: true, v: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // remove() on an already-gone container returns 404 — swallow.
      if (!message.includes("404")) throw err;
    }
  }

  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    this.assertAlive();
    const next = (this.state.expiresAt ?? Date.now()) + additionalMs;
    this.state.expiresAt = next;
    await this.hooks?.onTimeoutExtended?.(this, additionalMs);
    return { expiresAt: next };
  }

  async snapshot(): Promise<SnapshotResult> {
    this.assertAlive();
    const tag = `local-docker-snapshot-${this.state.sandboxId}-${Date.now()}`;
    await this.container.commit({ repo: tag.split(":")[0], tag: "latest", comment: "rmind sandbox snapshot" });
    return { snapshotId: `${tag.split(":")[0]}:latest` };
  }

  getState(): LocalDockerState {
    return { ...this.state, portMap: { ...this.state.portMap } };
  }

  // ---------- internals ----------

  private absolute(filePath: string): string {
    if (filePath.startsWith("/")) return path.posix.normalize(filePath);
    return path.posix.normalize(path.posix.join(this.workingDirectory, filePath));
  }

  private assertAlive(): void {
    if (this.stopped) throw new Error("sandbox: container has been stopped");
  }

  private async execShell(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<ExecResult> {
    return this.execRaw(["bash", "-lc", command], cwd, timeoutMs, signal);
  }

  private async execRaw(
    cmd: string[],
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const exec = await this.container.exec({
      Cmd: cmd,
      User: this.state.user,
      WorkingDir: cwd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({ hijack: true, stdin: false, Tty: false });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    const stdoutStream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (stdoutBytes + chunk.length > LOCAL_DOCKER_DEFAULTS.outputBudgetBytes) {
          truncated = true;
          const remaining = Math.max(0, LOCAL_DOCKER_DEFAULTS.outputBudgetBytes - stdoutBytes);
          if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes = LOCAL_DOCKER_DEFAULTS.outputBudgetBytes;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
        cb();
      },
    });
    const stderrStream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (stderrBytes + chunk.length > LOCAL_DOCKER_DEFAULTS.outputBudgetBytes) {
          truncated = true;
          const remaining = Math.max(0, LOCAL_DOCKER_DEFAULTS.outputBudgetBytes - stderrBytes);
          if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes = LOCAL_DOCKER_DEFAULTS.outputBudgetBytes;
        } else {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
        cb();
      },
    });
    this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);

    const handle: ExecHandle = {
      stop: async () => {
        try {
          const inspect = await exec.inspect();
          handle.pid = inspect.Pid;
          if (handle.pid && handle.pid > 0) {
            await this.container
              .exec({
                Cmd: ["kill", "-TERM", String(handle.pid)],
                User: "root",
                AttachStdout: false,
                AttachStderr: false,
              })
              .then((killExec) => killExec.start({ Detach: true }))
              .catch(() => undefined);
          }
        } catch {
          // best effort
        }
      },
    };
    this.activeExecs.add(handle);

    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void handle.stop();
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      void handle.stop();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    await new Promise<void>((resolve) => {
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
      stream.on("error", () => resolve());
    });

    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
    this.activeExecs.delete(handle);

    const inspection = await exec.inspect().catch(() => undefined);
    const exitCode = inspection?.ExitCode ?? null;

    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    const stderr = Buffer.concat(stderrChunks).toString("utf-8");

    if (timedOut) {
      return {
        success: false,
        exitCode,
        stdout,
        stderr: stderr + (stderr.endsWith("\n") ? "" : "\n") + `[timed out after ${timeoutMs}ms]`,
        truncated,
      };
    }
    if (aborted) {
      return {
        success: false,
        exitCode,
        stdout,
        stderr: stderr + (stderr.endsWith("\n") ? "" : "\n") + "[aborted]",
        truncated,
      };
    }
    return {
      success: exitCode === 0,
      exitCode,
      stdout,
      stderr,
      truncated,
    };
  }
}

function extractFirstFile(stream: NodeJS.ReadableStream): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    let captured: Buffer[] | null = null;
    let resolved = false;
    extract.on("entry", (header, entryStream, next) => {
      if (header.type !== "file" || captured !== null) {
        entryStream.resume();
        next();
        return;
      }
      captured = [];
      entryStream.on("data", (chunk: Buffer) => captured!.push(chunk));
      entryStream.on("end", () => next());
      entryStream.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
    extract.on("finish", () => {
      if (resolved) return;
      resolved = true;
      resolve(captured ? Buffer.concat(captured) : null);
    });
    extract.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    (stream as Readable).pipe(extract);
  });
}

function makeSingleFileArchive(name: string, content: string): NodeJS.ReadableStream {
  const pack = tar.pack();
  pack.entry({ name, mode: 0o644 }, content);
  pack.finalize();
  return pack;
}

function makeDirent(name: string, kind: string): Dirent {
  const isFile = kind === "f";
  const isDir = kind === "d";
  const isLink = kind === "l";
  // Dirent's constructor isn't stable across Node versions, so we hand-roll a compatible object.
  // The web app code only reads .name, .isFile(), .isDirectory(), .isSymbolicLink().
  return {
    name,
    parentPath: "",
    path: "",
    isFile: () => isFile,
    isDirectory: () => isDir,
    isSymbolicLink: () => isLink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as unknown as Dirent;
}
