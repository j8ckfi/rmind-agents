import type { SandboxStatus } from "../types";

export interface LocalDockerState {
  /** Stable identifier for this sandbox; also the container name. */
  sandboxId: string;
  /** Image tag the sandbox was created from. */
  baseImage: string;
  /** Where the cloned repo lives inside the container. */
  workingDirectory: string;
  /** Repo + branch that were cloned. */
  repo?: string;
  branch?: string;
  cloneUrl?: string;
  /** Active host:container port map for `domain(port)`. */
  portMap: Record<number, number>;
  /** Wall-clock millis when the sandbox is scheduled to be reaped. */
  expiresAt?: number;
  /** Initial timeout duration in millis, retained for status display. */
  timeoutMs: number;
  /** Lifecycle status — informational, the agent process is the source of truth. */
  status: SandboxStatus;
  /** Hostname the dev-server preview URLs should resolve to. */
  host: string;
  /** Username inside the container that owns /workspace. */
  user: string;
}
