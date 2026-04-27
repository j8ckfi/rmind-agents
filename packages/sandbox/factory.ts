import type { Sandbox, SandboxHooks } from "./interface";
import type { SandboxStatus } from "./types";
import { connectVercel } from "./vercel/connect";
import type { VercelState } from "./vercel/state";
import { connectLocalDockerSandbox } from "./local-docker/connect";
import type { LocalDockerState } from "./local-docker/state";

// Re-export SandboxStatus from types for convenience
export type { SandboxStatus };

/**
 * Unified sandbox state type.
 * Use `type` discriminator to determine which sandbox implementation to use.
 */
export type SandboxState =
  | ({ type: "vercel" } & VercelState)
  | ({ type: "local-docker" } & LocalDockerState);

/**
 * Base connect options for all sandbox types.
 */
export interface ConnectOptions {
  /** Environment variables available to sandbox commands */
  env?: Record<string, string>;
  /** GitHub token used for credential brokering; never exposed inside the sandbox */
  githubToken?: string;
  /** Git user for commits */
  gitUser?: { name: string; email: string };
  /** Lifecycle hooks */
  hooks?: SandboxHooks;
  /** Timeout in milliseconds for sandboxes (default: 300,000 = 5 minutes) */
  timeout?: number;
  /** Ports to expose from the sandbox for dev server preview URLs */
  ports?: number[];
  /** Snapshot ID used as the base image for new sandboxes */
  baseSnapshotId?: string;
  /** Whether to resume a stopped persistent sandbox session */
  resume?: boolean;
  /** Whether to create the named sandbox when it does not already exist */
  createIfMissing?: boolean;
  /** Whether new sandboxes should persist filesystem state between sessions */
  persistent?: boolean;
  /** Default expiration for automatic persistent-sandbox snapshots */
  snapshotExpiration?: number;
  /**
   * Skip git init in an empty workspace (e.g. when refreshing a Vercel base snapshot).
   */
  skipGitWorkspaceBootstrap?: boolean;
}

/**
 * Configuration for connecting to a sandbox.
 */
export type SandboxConnectConfig =
  | { state: { type: "vercel" } & VercelState; options?: ConnectOptions }
  | { state: { type: "local-docker" } & LocalDockerState; options?: ConnectOptions };

/**
 * Connect to a sandbox based on the provided configuration.
 *
 * Dispatch order:
 *   1. state.type === "local-docker" → connectLocalDockerSandbox
 *   2. state.type === "vercel" or unset → connectVercel (legacy default)
 *
 * Set SANDBOX_BACKEND=local-docker to make the rack default to LocalDockerSandbox
 * for newly-created sessions; existing rows keep working because the discriminator
 * lives inside the persisted state.
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
