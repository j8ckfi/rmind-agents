/**
 * HostSandbox — runs the agent directly on the host filesystem with no
 * containerization. Inspired by Factory Desktop's "managed computers" model:
 * for a single-user system on a trusted machine, container isolation is
 * unnecessary overhead. The agent's shell commands and file ops execute on
 * the host with the same privileges as the web process.
 *
 * Trade-offs vs LocalDockerSandbox:
 *  + No Docker, no virtualization, no base image build.
 *  + Works on Windows / macOS / Linux equally.
 *  + Faster — no container startup, no exec round-trip.
 *  - No isolation. The agent can touch anything the web process can.
 *  - dev-server preview ports can collide with host ports.
 */

import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
  SandboxType,
  SnapshotResult,
} from "../interface";
import type { HostState } from "./state";
import { HOST_DEFAULTS } from "./config";

const SANDBOX_TYPE: SandboxType = "cloud";

export interface HostSandboxParams {
  state: HostState;
  hooks?: SandboxHooks;
  env?: Record<string, string>;
  currentBranch?: string;
}

export class HostSandbox implements Sandbox {
  readonly type: SandboxType = SANDBOX_TYPE;
  readonly hooks?: SandboxHooks;
  readonly env?: Record<string, string>;

  private readonly state: HostState;
  private readonly currentBranchInternal?: string;
  private readonly active = new Set<{ kill: () => void }>();
  private stopped = false;

  constructor(params: HostSandboxParams) {
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
      `Sandbox: host (no isolation)`,
      `Working directory: ${this.workingDirectory}`,
      this.currentBranch ? `Current branch: ${this.currentBranch}` : undefined,
      `Platform: ${process.platform} ${process.arch}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // ---------- file ops ----------

  async readFile(filePath: string, _encoding: "utf-8"): Promise<string> {
    this.assertAlive();
    return fs.readFile(this.absolute(filePath), "utf-8");
  }

  async writeFile(filePath: string, content: string, _encoding: "utf-8"): Promise<void> {
    this.assertAlive();
    const absolute = this.absolute(filePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf-8");
  }

  async stat(filePath: string): Promise<SandboxStats> {
    this.assertAlive();
    const s = await fs.stat(this.absolute(filePath));
    return {
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  }

  async access(filePath: string): Promise<void> {
    this.assertAlive();
    await fs.access(this.absolute(filePath));
  }

  async mkdir(filePath: string, options?: { recursive?: boolean }): Promise<void> {
    this.assertAlive();
    await fs.mkdir(this.absolute(filePath), options);
  }

  async readdir(filePath: string, options: { withFileTypes: true }): Promise<Dirent[]> {
    this.assertAlive();
    return fs.readdir(this.absolute(filePath), options);
  }

  // ---------- execution ----------

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    this.assertAlive();
    return new Promise<ExecResult>((resolve) => {
      const isWin = process.platform === "win32";
      const child = isWin
        ? spawn("cmd.exe", ["/d", "/s", "/c", command], { cwd, env: { ...process.env, ...(this.env ?? {}) } })
        : spawn("bash", ["-lc", command], { cwd, env: { ...process.env, ...(this.env ?? {}) } });

      const handle = { kill: () => child.kill("SIGTERM") };
      this.active.add(handle);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      const budget = HOST_DEFAULTS.outputBudgetBytes;

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutBytes + chunk.length > budget) {
          truncated = true;
          const remaining = Math.max(0, budget - stdoutBytes);
          if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes = budget;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBytes + chunk.length > budget) {
          truncated = true;
          const remaining = Math.max(0, budget - stderrBytes);
          if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
          stderrBytes = budget;
        } else {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
      });

      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      const onAbort = () => {
        aborted = true;
        child.kill("SIGTERM");
      };
      if (options?.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }

      child.on("close", (code) => {
        clearTimeout(timer);
        if (options?.signal) options.signal.removeEventListener("abort", onAbort);
        this.active.delete(handle);
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        let stderr = Buffer.concat(stderrChunks).toString("utf-8");
        if (timedOut) stderr += `\n[timed out after ${timeoutMs}ms]`;
        if (aborted) stderr += "\n[aborted]";
        resolve({
          success: !timedOut && !aborted && code === 0,
          exitCode: code,
          stdout,
          stderr,
          truncated,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        this.active.delete(handle);
        resolve({
          success: false,
          exitCode: null,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          truncated: false,
        });
      });
    });
  }

  async execDetached(command: string, cwd: string): Promise<{ commandId: string }> {
    this.assertAlive();
    const isWin = process.platform === "win32";
    const child = isWin
      ? spawn("cmd.exe", ["/d", "/s", "/c", command], { cwd, detached: true, stdio: "ignore" })
      : spawn("bash", ["-lc", command], { cwd, detached: true, stdio: "ignore" });
    child.unref();
    return { commandId: String(child.pid ?? Math.random()) };
  }

  // ---------- lifecycle ----------

  domain(port: number): string {
    return `http://${this.state.host}:${port}`;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const handle of this.active) {
      try {
        handle.kill();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
    await this.hooks?.beforeStop?.(this);
  }

  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    this.assertAlive();
    const next = (this.state.expiresAt ?? Date.now()) + additionalMs;
    this.state.expiresAt = next;
    await this.hooks?.onTimeoutExtended?.(this, additionalMs);
    return { expiresAt: next };
  }

  async snapshot(): Promise<SnapshotResult> {
    // No snapshotting on the host backend; return a no-op identifier so the
    // workflow can persist state without crashing.
    return { snapshotId: `host-${this.state.sandboxId}-${Date.now()}` };
  }

  getState(): HostState {
    return { ...this.state };
  }

  // ---------- internals ----------

  private absolute(filePath: string): string {
    if (path.isAbsolute(filePath)) return path.normalize(filePath);
    return path.normalize(path.join(this.workingDirectory, filePath));
  }

  private assertAlive(): void {
    if (this.stopped) throw new Error("sandbox: host sandbox has been stopped");
  }
}
