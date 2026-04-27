import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Sandbox, SandboxHooks } from "../interface";
import type { Source } from "../types";
import { HOST_DEFAULTS } from "./config";
import { HostSandbox } from "./sandbox";
import type { HostState } from "./state";

export interface HostSandboxConfig {
  source?: Source;
  hooks?: SandboxHooks;
  timeoutMs?: number;
  env?: Record<string, string>;
  gitUser?: { name: string; email: string };
  githubToken?: string;
}

export interface HostSandboxConnectConfig {
  state: HostState;
  options?: HostSandboxConfig;
}

export async function connectHostSandbox(
  state: HostState,
  options?: HostSandboxConfig,
): Promise<Sandbox> {
  await fs.mkdir(state.workingDirectory, { recursive: true });
  // Optional clone/checkout. If the directory already has a .git, just fetch+checkout.
  if (options?.source?.repo) {
    const exists = await fs
      .stat(path.join(state.workingDirectory, ".git"))
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      const { spawn } = await import("node:child_process");
      const repo = options.source.repo;
      const token = options.source.token;
      const cloneUrl = token
        ? repo.replace("https://", `https://x-access-token:${token}@`)
        : repo;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "git",
          ["clone", "--branch", options.source!.branch ?? "main", "--depth", "50", cloneUrl, state.workingDirectory],
          { stdio: "ignore" },
        );
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git clone exit ${code}`))));
        child.on("error", reject);
      });
    }
  }

  const merged: HostState = {
    ...state,
    expiresAt: state.expiresAt ?? Date.now() + (options?.timeoutMs ?? state.timeoutMs ?? HOST_DEFAULTS.timeoutMs),
    timeoutMs: options?.timeoutMs ?? state.timeoutMs ?? HOST_DEFAULTS.timeoutMs,
    status: "ready",
  };
  const sandbox = new HostSandbox({
    state: merged,
    hooks: options?.hooks,
    env: options?.env,
    currentBranch: options?.source?.branch ?? state.branch,
  });
  await options?.hooks?.afterStart?.(sandbox);
  return sandbox;
}

export interface CreateHostSandboxParams {
  source?: Source;
  options?: HostSandboxConfig;
  workingDirectory?: string;
}

export async function createHostSandbox(params: CreateHostSandboxParams): Promise<Sandbox> {
  const state: HostState = {
    sandboxId: `host-${randomUUID()}`,
    workingDirectory: params.workingDirectory ?? HOST_DEFAULTS.workingDirectory,
    repo: params.source?.repo,
    branch: params.source?.branch,
    cloneUrl: params.source?.repo,
    timeoutMs: params.options?.timeoutMs ?? HOST_DEFAULTS.timeoutMs,
    status: "starting",
    host: HOST_DEFAULTS.host,
  };
  return connectHostSandbox(state, { ...(params.options ?? {}), source: params.source });
}
