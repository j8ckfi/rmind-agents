/**
 * Liveness probe for the rack web container. The cloudflared service uses this
 * to gate `condition: service_healthy` before opening the tunnel, and the
 * Vercel proxy rewrites GET /api/health → rack/api/health for end-to-end checks.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({
      status: "ok",
      service: "rmind-agents-web",
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
}
