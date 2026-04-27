#!/usr/bin/env bash
## Build the LocalDockerSandbox base image.
## Usage: ./build.sh                              # builds open-agents-sandbox:base
##        SANDBOX_BASE_IMAGE=foo:tag ./build.sh   # custom tag

set -euo pipefail

IMAGE_TAG="${SANDBOX_BASE_IMAGE:-open-agents-sandbox:base}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

echo ">> building ${IMAGE_TAG}"
docker build \
  --pull \
  --tag "${IMAGE_TAG}" \
  --label "org.open-agents.sandbox.base=true" \
  --file "${SCRIPT_DIR}/Dockerfile" \
  "${SCRIPT_DIR}"

echo ">> built ${IMAGE_TAG}"
echo ">> verify by running: docker run --rm ${IMAGE_TAG} bash -lc 'node --version && bun --version && python3 --version && rg --version | head -1'"
