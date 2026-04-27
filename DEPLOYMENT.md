# Deploying rmind-agents to agents.rmind.us

This document is the single source of truth for getting the self-hosted fork
running. Read it end-to-end before touching anything; some steps depend on
others (e.g. the GitHub App can only be created after the Vercel domain is
live).

## Architecture recap

```
browser ──► agents.rmind.us (Vercel proxy) ──► Cloudflare Tunnel ──► rack:3000
                                                                     ├─ Next.js
                                                                     ├─ Postgres
                                                                     └─ docker.sock ──► sandbox containers
```

- Vercel: TLS, OAuth callback, all dynamic routes are rewrites to the rack.
- Cloudflare Tunnel: outbound-only connection from the rack to CF's edge.
- Rack: a Linux box you control. Runs the web app, Postgres, and the per-task
  Docker sandbox containers.

## What the agent has already done (in this fork)

| Phase | Files | Status |
|-------|-------|--------|
| Sandbox swap | `packages/sandbox/local-docker/`, `packages/sandbox/docker/Dockerfile` | committed |
| Sandbox factory dispatch | `packages/sandbox/factory.ts`, `packages/sandbox/index.ts` | committed |
| Pi agent wrapper | `packages/pi-agent/` | committed |
| Pi tool adapter | `packages/pi-agent/src/tools.ts` | committed |
| Models.json template | `packages/pi-agent/templates/models.json` | committed |
| Workflow shim | `packages/local-workflow/` | committed |
| Rack docker-compose | `deploy/rack/` | committed |
| Cloudflare tunnel template | `deploy/cloudflared/` | committed |
| Vercel proxy project | `deploy/vercel/` | committed |
| Web app rewire to pi agent | `apps/web/app/workflows/chat.ts` | committed (gated on AGENT_BACKEND=pi) |

## What you must still do (manual)

These steps cannot be automated — they require credentials, browser logins,
or DNS that only the human owner can authorize.

### 1. On the rack — bring up Postgres and the sandbox base image

```bash
git clone https://github.com/j8ckfi/rmind-agents.git
cd rmind-agents
git checkout rmind/self-hosted-fork

# build the sandbox base image (one-off, ~3 min)
bash packages/sandbox/docker/build.sh

# seed pi config
mkdir -p deploy/rack/pi
cp packages/pi-agent/templates/models.json deploy/rack/pi/models.json
cp packages/pi-agent/templates/auth.json.example deploy/rack/pi/auth.json
chmod 600 deploy/rack/pi/auth.json

# fill secrets
cp deploy/rack/.env.example deploy/rack/.env
$EDITOR deploy/rack/.env       # paste real values
```

### 2. Create the Cloudflare Tunnel

```bash
sudo apt install cloudflared
cloudflared tunnel login                      # browser → pick rmind.us
cloudflared tunnel create rmind-agents
cloudflared tunnel route dns rmind-agents agents.rmind.us
cloudflared tunnel token rmind-agents         # paste into deploy/rack/.env
```

### 3. Auth the API providers

```bash
echo "OPENCODE_GO_API_KEY=sk-..." >> deploy/rack/.env
echo "ANTHROPIC_API_KEY=sk-ant-..." >> deploy/rack/.env

# pi auth login is interactive — must be done over SSH with port-forwarding
# from your laptop:
ssh rack -L 8765:localhost:8765
pi auth login codex      # browser opens locally; complete the OAuth flow
pi auth login copilot    # only if you want Copilot models too
```

### 4. Vercel — create the proxy project

> **At this step, the autonomous agent will pause and ask you to run
> `vercel login` if it has not been authed yet.** The agent cannot complete
> Vercel deploy without your auth.

```bash
cd deploy/vercel
npm install
npx vercel login                             # browser → email magic link
npx vercel link                              # creates .vercel/, picks team
npx vercel domains add agents.rmind.us       # adds the domain to the project
npx vercel env add RACK_TUNNEL_ORIGIN production
# value: https://agents.rmind.us
npx vercel env add NEXT_PUBLIC_GITHUB_CLIENT_ID production
npx vercel env add GITHUB_CLIENT_SECRET production
npx vercel --prod                            # ships the proxy
```

DNS for rmind.us is already on Cloudflare; the tunnel command in step 2
already wrote the A/CNAME for `agents.rmind.us` → tunnel UUID. Vercel's
domain setup will happily live alongside that.

### 5. Create the GitHub App

GitHub.com → Settings → Developer settings → GitHub Apps → New GitHub App.

| Field | Value |
|-------|-------|
| Name | rmind-agents (or anything you like) |
| Homepage URL | `https://agents.rmind.us` |
| Callback URL | `https://agents.rmind.us/api/auth/callback/github` |
| Setup URL | `https://agents.rmind.us/api/github/app/callback` |
| Webhook | leave off for v1 |
| Permissions | Repository: contents (R/W), pull requests (R/W), issues (R/W), metadata (R), workflows (R/W). Account: email (R) |

Generate a private key, base64 it, and add as `GITHUB_APP_PRIVATE_KEY_BASE64`
in `deploy/rack/.env`. Add the App ID and client id/secret to the same file
and to Vercel env.

### 6. Boot the rack stack

```bash
cd deploy/rack
docker compose --env-file .env up -d
docker compose logs -f web
```

Wait for "Ready in" from Next.js. Visit `https://agents.rmind.us` from your
laptop. You should see the open-agents login page served by the rack.

### 7. Smoke test checklist

- [ ] Browser loads `https://agents.rmind.us` and the page is served by the
      rack (check `X-Powered-By` header — should be Next.js, not Vercel
      Functions).
- [ ] "Login with GitHub" completes and you land on the dashboard.
- [ ] Connect a GitHub repo via the app installation flow.
- [ ] Create a new task with prompt "list the files in the repo root" and
      pin model to `opencode-go/glm-5.1`.
- [ ] Stream renders text + tool-call chunks in real time.
- [ ] After completion, a branch is pushed to GitHub and a PR is opened.
- [ ] Closing the laptop and reopening on the phone shows the same task with
      full history (session is server-side).

## Provider auth re-up cadence

| Provider | Refresh | Manual interval |
|---|---|---|
| OpenCode Go | API key, no expiry | until you rotate |
| Anthropic | API key, no expiry | until you rotate |
| Codex (OAuth) | auto-refresh by pi | re-login every ~30 days, SSH + port forward |
| GitHub Copilot (OAuth) | auto-refresh by pi | similar to Codex |

## What can go wrong

- **Docker daemon not running** — `docker compose up -d` will fail. On
  Windows make sure Docker Desktop is running; on Linux check `systemctl
  status docker`.
- **Sandbox base image missing** — `LocalDockerSandbox` will fail to start
  containers with "image not found". Re-run `packages/sandbox/docker/build.sh`.
- **Pi auth.json absent or wrong perms** — pi will refuse to refresh tokens.
  Verify `chmod 600 deploy/rack/pi/auth.json`.
- **Vercel rewrite loop** — if `RACK_TUNNEL_ORIGIN` resolves back to Vercel
  instead of through the tunnel, requests will bounce. Always use the tunnel
  hostname (`agents.rmind.us`) and ensure DNS routes through Cloudflare.
- **Cloudflare 100s idle timeout** — if streams cut at exactly 100s, confirm
  the agent is emitting heartbeats. See `deploy/cloudflared/README.md`.
