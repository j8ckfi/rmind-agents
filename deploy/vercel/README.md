# Vercel proxy — agents.rmind.us

This subdirectory is a separate, minimal Next.js project deployed to Vercel.
It exists for two reasons:

1. **Stable HTTPS origin for OAuth callbacks.** GitHub Apps require a fixed
   HTTPS callback URL; using `agents.rmind.us` (Vercel-managed) is more stable
   than a Cloudflare Tunnel hostname during dev iterations.
2. **Free TLS + DNS** for the public-facing domain.

Everything else — agent runner, sandboxes, Postgres, AI SDK calls — runs on
the rack. This project rewrites all dynamic routes to `RACK_TUNNEL_ORIGIN`
and only executes the `/api/github/app/callback` handler locally.

## Setup (manual, requires user action)

> **Vercel auth is a manual step.** The agent stops here and waits for you.

```bash
cd deploy/vercel
npm install
npx vercel link            # creates .vercel/, links to a new project
npx vercel env add RACK_TUNNEL_ORIGIN production       # https://agents.rmind.us
npx vercel env add NEXT_PUBLIC_GITHUB_CLIENT_ID production
npx vercel env add GITHUB_CLIENT_SECRET production
npx vercel domains add agents.rmind.us
npx vercel --prod
```

Then point the GitHub App's callback URL at
`https://agents.rmind.us/api/github/app/callback` and the user-authorization
URL at `https://agents.rmind.us/api/auth/callback/github`.

## What this project deliberately does NOT do

- No Drizzle, no Postgres connection, no AI SDK keys, no agent code.
- No `bun`/`pnpm` workspace linkage. It's a flat npm project so Vercel's
  default build pipeline works without overrides.
- No Vercel Sandbox, no Vercel Workflow.
