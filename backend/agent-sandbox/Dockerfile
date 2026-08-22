# Agent sandbox — long-lived workspace containers for run_command.
# Keeps git, node, python, and common build tools; the working tree lives
# on a named volume mounted at /workspace. Bare repos are mounted read-only
# at /data/repos for git resync on wake (no JSON session files).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    git \
    g++ \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["sleep", "infinity"]
