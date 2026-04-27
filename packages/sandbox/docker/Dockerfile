## Sandbox base image for LocalDockerSandbox.
## Mirrors the toolset on the Vercel sandbox snapshot so existing tools/skills behave the same.
## Build with packages/sandbox/docker/build.sh — never bake secrets into this image; tokens are injected via env at create() time.

FROM debian:bookworm-slim

ARG TARGETARCH
ARG NODE_MAJOR=20
ARG BUN_VERSION=1.2.14
ARG PNPM_VERSION=9.15.4
ARG AGENT_USER=agent
ARG AGENT_UID=1000
ARG AGENT_GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/home/${AGENT_USER}/.local/bin:/home/${AGENT_USER}/.bun/bin:/usr/local/lib/node_modules/.bin:$PATH \
    BUN_INSTALL=/home/${AGENT_USER}/.bun \
    PNPM_HOME=/home/${AGENT_USER}/.local/share/pnpm

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg unzip xz-utils \
        git openssh-client \
        ripgrep fd-find jq \
        build-essential pkg-config \
        python3 python3-pip python3-venv \
        sudo less; \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    npm install -g pnpm@${PNPM_VERSION}; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    groupadd --gid ${AGENT_GID} ${AGENT_USER}; \
    useradd --uid ${AGENT_UID} --gid ${AGENT_GID} --shell /bin/bash --create-home ${AGENT_USER}; \
    install -d -o ${AGENT_USER} -g ${AGENT_USER} /workspace; \
    install -d -o ${AGENT_USER} -g ${AGENT_USER} /home/${AGENT_USER}/.bun; \
    install -d -o ${AGENT_USER} -g ${AGENT_USER} /home/${AGENT_USER}/.local; \
    install -d -o ${AGENT_USER} -g ${AGENT_USER} /home/${AGENT_USER}/.cache

USER ${AGENT_USER}
WORKDIR /home/${AGENT_USER}

RUN set -eux; \
    curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

USER root
RUN ln -sf /home/${AGENT_USER}/.bun/bin/bun /usr/local/bin/bun

USER ${AGENT_USER}
WORKDIR /workspace

## A long-running container is the simplest way to host an interactive sandbox.
## The agent process drives this container via docker exec, so the entrypoint just
## keeps PID 1 alive and prints state to stderr if the container is started directly.
CMD ["bash", "-lc", "echo 'open-agents sandbox idle; awaiting docker exec'; exec sleep infinity"]
