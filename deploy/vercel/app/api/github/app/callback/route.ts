/**
 * GitHub App OAuth callback — runs on Vercel because GitHub's redirect URL must
 * match a public, stable HTTPS origin. We don't do any token exchange here;
 * we just forward the query string to the rack which has the GITHUB_CLIENT_SECRET
 * and persists the install in Postgres.
 */

import { NextResponse } from "next/server";

const RACK = process.env.RACK_TUNNEL_ORIGIN ?? "https://agents.rmind.us";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const forwardUrl = new URL("/api/github/app/callback", RACK);
  url.searchParams.forEach((value, key) => forwardUrl.searchParams.set(key, value));
  // Preserve cookies (better-auth state) so the rack can validate the OAuth roundtrip.
  const cookieHeader = request.headers.get("cookie") ?? "";
  const upstream = await fetch(forwardUrl.toString(), {
    method: "GET",
    redirect: "manual",
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });
  // Mirror the rack's redirect verbatim so the browser lands on the right page.
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("location") ?? "/";
    const setCookies = upstream.headers.getSetCookie?.() ?? [];
    const response = NextResponse.redirect(new URL(location, RACK), upstream.status);
    for (const sc of setCookies) response.headers.append("set-cookie", sc);
    return response;
  }
  // Non-redirect (error path) — pass through with original status.
  const body = await upstream.text();
  return new NextResponse(body, { status: upstream.status, headers: upstream.headers });
}
