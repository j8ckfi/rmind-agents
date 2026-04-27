export const LOCAL_DOCKER_DEFAULTS = {
  baseImage: process.env.SANDBOX_BASE_IMAGE ?? "open-agents-sandbox:base",
  workingDirectory: "/workspace",
  user: "agent",
  host: process.env.SANDBOX_PUBLIC_HOST ?? "localhost",
  timeoutMs: 5 * 60 * 60 * 1000,
  execTimeoutMs: 5 * 60 * 1000,
  outputBudgetBytes: 4 * 1024 * 1024,
  containerNamePrefix: "rmind-sandbox-",
} as const;
