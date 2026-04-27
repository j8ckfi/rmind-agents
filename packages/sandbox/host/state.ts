import type { SandboxStatus } from "../types";

export interface HostState {
  sandboxId: string;
  workingDirectory: string;
  repo?: string;
  branch?: string;
  cloneUrl?: string;
  expiresAt?: number;
  timeoutMs: number;
  status: SandboxStatus;
  host: string;
}
