import { randomUUID } from "crypto";
import Docker from "dockerode";
import type { Sandbox, SandboxHooks } from "../interface";
import type { Source } from "../types";
import { LOCAL_DOCKER_DEFAULTS } from "./config";
import { LocalDockerSandbox } from "./sandbox";
import type { LocalDockerState } from "./state";

export interface LocalDockerSandboxConfig {
  /** Optional explicit Docker socket (defaults to env DOCKER_HOST or unix socket). */
  socketPath?: string;
  /** Repository to clone on create. Skipped on resume. */
  source?: Source;
  /** Ports to expose from the container. */
  ports?: number[];
  /** Hooks to invoke through the lifecycle. */
  hooks?: SandboxHooks;
  /** Initial timeout in ms (default 5h). */
  timeoutMs?: number;
  /** Image override; falls back to SANDBOX_BASE_IMAGE then config default. */
  baseImage?: string;
  /** Labels passed to docker create. */
  labels?: Record<string, string>;
  /** Env vars set inside the container. */
  env?: Record<string, string>;
  /** Git identity to inject (for commits). */
  gitUser?: { name: string; email: string };
  /** GitHub token to inject for `git fetch/push`. Never returned in state. */
  githubToken?: string;
}

export interface LocalDockerSandboxConnectConfig {
  state: LocalDockerState;
  options?: LocalDockerSandboxConfig;
}

function dockerFromEnv(socketPath?: string): Docker {
  if (socketPath) return new Docker({ socketPath });
  const dockerHost = process.env.SANDBOX_DOCKER_HOST ?? process.env.DOCKER_HOST;
  if (!dockerHost) return new Docker();
  if (dockerHost.startsWith("unix://")) return new Docker({ socketPath: dockerHost.slice("unix://".length) });
  if (dockerHost.startsWith("tcp://")) {
    const url = new URL(dockerHost);
    return new Docker({ host: url.hostname, port: Number(url.port || 2375) });
  }
  return new Docker({ socketPath: dockerHost });
}

async function ensureContainer(
  docker: Docker,
  state: LocalDockerState,
  config: LocalDockerSandboxConfig,
): Promise<{ container: Docker.Container; portMap: Record<number, number> }> {
  const containerName = state.sandboxId;
  const existing = docker.getContainer(containerName);
  try {
    const inspect = await existing.inspect();
    const portMap: Record<number, number> = {};
    const bindings = inspect.NetworkSettings?.Ports ?? {};
    for (const [containerPort, hostBindings] of Object.entries(bindings)) {
      const num = Number(containerPort.split("/")[0]);
      const hostPort = hostBindings?.[0]?.HostPort;
      if (Number.isFinite(num) && hostPort) portMap[num] = Number(hostPort);
    }
    if (inspect.State?.Status !== "running") {
      await existing.start();
    }
    return { container: existing, portMap };
  } catch {
    // not found — create
  }

  const ports = config.ports ?? [];
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};
  for (const port of ports) {
    exposedPorts[`${port}/tcp`] = {};
    // HostPort "" lets docker pick a free port; we read the assignment back via inspect.
    portBindings[`${port}/tcp`] = [{ HostPort: "" }];
  }

  const env: string[] = [];
  if (config.env) {
    for (const [k, v] of Object.entries(config.env)) env.push(`${k}=${v}`);
  }
  if (config.githubToken) env.push(`GITHUB_TOKEN=${config.githubToken}`);

  const container = await docker.createContainer({
    name: containerName,
    Image: state.baseImage,
    User: state.user,
    WorkingDir: state.workingDirectory,
    Env: env,
    ExposedPorts: exposedPorts,
    Labels: {
      "org.open-agents.sandbox": "true",
      "org.open-agents.sandbox.id": state.sandboxId,
      ...(config.labels ?? {}),
    },
    HostConfig: {
      AutoRemove: false,
      NetworkMode: "bridge",
      PortBindings: portBindings,
      // SecurityOpt + ReadonlyRootfs left default; v1 trusts the base image.
    },
    Tty: false,
    OpenStdin: false,
  });
  await container.start();

  const inspected = await container.inspect();
  const portMap: Record<number, number> = {};
  const bindings = inspected.NetworkSettings?.Ports ?? {};
  for (const [containerPort, hostBindings] of Object.entries(bindings)) {
    const num = Number(containerPort.split("/")[0]);
    const hostPort = hostBindings?.[0]?.HostPort;
    if (Number.isFinite(num) && hostPort) portMap[num] = Number(hostPort);
  }

  // Bootstrap: ensure /workspace exists, configure git identity, optionally clone.
  await runInContainer(container, state.user, state.workingDirectory, [
    "sh",
    "-c",
    `mkdir -p "${state.workingDirectory}"`,
  ]);
  if (config.gitUser) {
    await runInContainer(container, state.user, state.workingDirectory, [
      "sh",
      "-c",
      `git config --global user.name "${config.gitUser.name.replace(/"/g, '\\"')}" && git config --global user.email "${config.gitUser.email.replace(/"/g, '\\"')}"`,
    ]);
  }
  if (config.source?.repo) {
    const repo = config.source.repo;
    const branch = config.source.branch ?? "main";
    const token = config.source.token;
    const cloneUrl = token
      ? repo.replace("https://", `https://x-access-token:${token}@`)
      : repo;
    const cloneCmd = `git clone --branch "${branch}" --depth 50 "${cloneUrl}" "${state.workingDirectory}" 2>&1 || (cd "${state.workingDirectory}" && git fetch origin "${branch}" && git checkout "${branch}")`;
    await runInContainer(container, state.user, "/", ["sh", "-c", cloneCmd]);
    if (config.source.newBranch) {
      await runInContainer(container, state.user, state.workingDirectory, [
        "sh",
        "-c",
        `git checkout -b "${config.source.newBranch}"`,
      ]);
    }
  }

  return { container, portMap };
}

async function runInContainer(
  container: Docker.Container,
  user: string,
  cwd: string,
  cmd: string[],
): Promise<void> {
  const exec = await container.exec({
    Cmd: cmd,
    User: user,
    WorkingDir: cwd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ hijack: true, stdin: false, Tty: false });
  await new Promise<void>((resolve) => {
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
    stream.on("error", () => resolve());
    stream.resume();
  });
}

export async function connectLocalDockerSandbox(
  state: LocalDockerState,
  options?: LocalDockerSandboxConfig,
): Promise<Sandbox> {
  const docker = dockerFromEnv(options?.socketPath);
  const { container, portMap } = await ensureContainer(docker, state, options ?? {});

  const merged: LocalDockerState = {
    ...state,
    portMap: { ...state.portMap, ...portMap },
    expiresAt: state.expiresAt ?? Date.now() + (options?.timeoutMs ?? state.timeoutMs ?? LOCAL_DOCKER_DEFAULTS.timeoutMs),
    timeoutMs: options?.timeoutMs ?? state.timeoutMs ?? LOCAL_DOCKER_DEFAULTS.timeoutMs,
    status: "ready",
  };
  const sandbox = new LocalDockerSandbox({
    state: merged,
    docker,
    container,
    hooks: options?.hooks,
    env: options?.env,
    currentBranch: options?.source?.newBranch ?? options?.source?.branch ?? state.branch,
  });
  await options?.hooks?.afterStart?.(sandbox);
  return sandbox;
}

export interface CreateLocalDockerSandboxParams {
  source?: Source;
  options?: LocalDockerSandboxConfig;
}

export async function createLocalDockerSandbox(params: CreateLocalDockerSandboxParams): Promise<Sandbox> {
  const sandboxId = `${LOCAL_DOCKER_DEFAULTS.containerNamePrefix}${randomUUID()}`;
  const state: LocalDockerState = {
    sandboxId,
    baseImage: params.options?.baseImage ?? LOCAL_DOCKER_DEFAULTS.baseImage,
    workingDirectory: LOCAL_DOCKER_DEFAULTS.workingDirectory,
    repo: params.source?.repo,
    branch: params.source?.branch,
    cloneUrl: params.source?.repo,
    portMap: {},
    timeoutMs: params.options?.timeoutMs ?? LOCAL_DOCKER_DEFAULTS.timeoutMs,
    status: "starting",
    host: LOCAL_DOCKER_DEFAULTS.host,
    user: LOCAL_DOCKER_DEFAULTS.user,
  };
  return connectLocalDockerSandbox(state, { ...(params.options ?? {}), source: params.source });
}
