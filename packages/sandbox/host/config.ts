export const HOST_DEFAULTS = {
  workingDirectory: process.env.HOST_SANDBOX_ROOT ?? process.cwd(),
  host: process.env.SANDBOX_PUBLIC_HOST ?? "localhost",
  timeoutMs: 5 * 60 * 60 * 1000,
  outputBudgetBytes: 4 * 1024 * 1024,
} as const;
