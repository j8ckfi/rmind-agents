/**
 * `workflow/next` subpath. Provides withWorkflow(nextConfig) which the upstream
 * project uses to wrap the Next.js config. The shim is a no-op identity wrapper
 * because the rack runtime keeps workflows in-process — there's nothing to
 * inject into the Next.js build pipeline.
 */

export function withWorkflow<T>(nextConfig: T): T {
  return nextConfig;
}
