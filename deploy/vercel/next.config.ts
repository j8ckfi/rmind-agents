/**
 * Vercel-side proxy for agents.rmind.us. The only routes that actually execute
 * on Vercel are the GitHub App OAuth callbacks; everything else is rewritten
 * to the rack via Cloudflare Tunnel. This keeps Vercel on the free tier and
 * keeps agent code, sandboxes, and AI SDK calls on the rack where the user
 * controls cost and trust.
 *
 * Required env (set via `vercel env add`):
 *   - RACK_TUNNEL_ORIGIN     e.g. https://agents.rmind.us  (the public hostname
 *                                                         that resolves through
 *                                                         the rack tunnel)
 *   - NEXT_PUBLIC_GITHUB_CLIENT_ID   public client id for the GitHub App
 *   - GITHUB_CLIENT_SECRET           used by /api/github/app/callback only
 */

import type { NextConfig } from "next";

const RACK = process.env.RACK_TUNNEL_ORIGIN ?? "https://agents.rmind.us";

const config: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  async rewrites() {
    return {
      beforeFiles: [
        // GitHub callbacks must execute on Vercel so the OAuth redirect works.
        // Everything else falls through to the rack.
      ],
      afterFiles: [
        { source: "/", destination: `${RACK}/` },
        { source: "/dashboard/:path*", destination: `${RACK}/dashboard/:path*` },
        { source: "/sessions/:path*", destination: `${RACK}/sessions/:path*` },
        { source: "/chats/:path*", destination: `${RACK}/chats/:path*` },
        { source: "/settings/:path*", destination: `${RACK}/settings/:path*` },
        { source: "/admin/:path*", destination: `${RACK}/admin/:path*` },
        { source: "/api/auth/:path*", destination: `${RACK}/api/auth/:path*` },
        { source: "/api/chat/:path*", destination: `${RACK}/api/chat/:path*` },
        { source: "/api/sessions/:path*", destination: `${RACK}/api/sessions/:path*` },
        { source: "/api/repos/:path*", destination: `${RACK}/api/repos/:path*` },
        { source: "/api/sandbox/:path*", destination: `${RACK}/api/sandbox/:path*` },
        { source: "/api/health", destination: `${RACK}/api/health` },
        { source: "/_next/data/:path*", destination: `${RACK}/_next/data/:path*` },
      ],
      fallback: [
        // Anything not matched and not statically served goes to the rack.
        { source: "/:path*", destination: `${RACK}/:path*` },
      ],
    };
  },
  async headers() {
    return [
      {
        source: "/api/github/app/callback",
        headers: [
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default config;
