import type { Sandbox, SandboxHooks } from "./interface";
import type { SandboxStatus } from "./types";
import { connectVercel } from "./vercel/connect";
import type { VercelState } from "./vercel/state";
import { connectLocalDockerSandbox } from "./local-docker/connect";
import type { LocalDockerState } from "./local-docker/state";
import { connectHostSandbox } from "./host/connect";
import type { HostState } from "./host/state";

// Re-export SandboxStatus from types for convenience
export type { SandboxStatus };

/**
 * Unified sandbox state type. Three backends:
 *   - vercel        : @vercel/sandbox (cloud isolation, pay-as-you-go)
 *   - local-docker  : Docker container per task on a Linux rack
 *   - host          : runs directly on the host filesystem (no isolation; trust the box)
 */
export type SandboxState =
  | ({ type: "vercel" } & VercelState)
  | ({ type: "local-docker" } & LocalDockerState)
  | ({ type: "host" } & HostState);

/**
 * Base connect options for all sandbox types.
 */
export interface ConnectOptions {
  env?: Record<string, string>;
  githubToken?: string;
  gitUser?: { name: string; email: string };
  hooks?: SandboxHooks;
  timeout?: number;
  ports?: number[];
  baseSnapshotId?: string;
  resume?: boolean;
  createIfMissing?: boolean;
  persistent?: boolean;
  snapshotExpiration?: number;
  skipGitWorkspaceBootstrap?: boolean;
}

export type SandboxConnectConfig =
  | { state: { type: "vercel" } & VercelState; options?: ConnectOptions }
  | { state: { type: "local-docker" } & LocalDockerState; options?: ConnectOptions }
  | { state: { type: "host" } & HostState; options?: ConnectOptions };

/**
 * Connect to a sandbox based on the provided configuration.
 */
export async function connectSandbox(
  configOrState: SandboxConnectConfig | SandboxState,
  legacyOptions?: ConnectOptions,
): Promise<Sandbox> {
  const isNewApi =
    typeof configOrState === "object" &&
    "state" in configOrState &&
    typeof (configOrState as SandboxConnectConfig).state === "object" &&
    "type" in (configOrState as SandboxConnectConfig).state;

  const config = isNewApi
    ? (configOrState as SandboxConnectConfig)
    : { state: configOrState as SandboxState, options: legacyOptions };

  if (config.state.type === "host") {
    return connectHostSandbox(config.state, {
      hooks: config.options?.hooks,
      timeoutMs: config.options?.timeout,
      env: config.options?.env,
      gitUser: config.options?.gitUser,
      githubToken: config.options?.githubToken,
    });
  }

  if (config.state.type === "local-docker") {
    return connectLocalDockerSandbox(config.state, {
      hooks: config.options?.hooks,
      timeoutMs: config.options?.timeout,
      ports: config.options?.ports,
      env: config.options?.env,
      gitUser: config.options?.gitUser,
      githubToken: config.options?.githubToken,
    });
  }

  return connectVercel(config.state, config.options);
}
