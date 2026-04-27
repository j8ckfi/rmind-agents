## Build image for the rmind-agents web app.
## Uses Bun for install + build, then a slim runtime that still has docker CLI
## available so the LocalDockerSandbox factory can talk to /var/run/docker.sock.

FROM oven/bun:1.2.14 AS deps
WORKDIR /repo
COPY package.json bun.lock turbo.json tsconfig.json ./
COPY apps/web/package.json apps/web/
COPY packages packages
RUN bun install --frozen-lockfile

FROM oven/bun:1.2.14 AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules /repo/node_modules
COPY . .
RUN bun run --cwd apps/web build

FROM debian:bookworm-slim AS runtime
ARG TARGETARCH
ENV NODE_ENV=production \
    PORT=3000

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=${TARGETARCH:-amd64} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /repo /app
EXPOSE 3000
CMD ["node", "apps/web/.next/standalone/server.js"]
