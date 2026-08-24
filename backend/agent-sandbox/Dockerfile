# Agent sandbox — long-lived workspace containers for run_command.
# Keeps git, node, python, and common build tools; the working tree lives
# on a named volume mounted at /workspace. Bare repos are mounted read-only
# at /data/repos for git resync on wake (no JSON session files).
FROM node:22-bookworm-slim

# Common CLIs the agent actually hits (curl/jq/rg/archives) plus pytest so
# Python repos can go red/green without a per-session pip install.
# wget omitted — curl covers it. No docker-in-docker.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    git \
    g++ \
    make \
    python3 \
    python3-pytest \
    curl \
    jq \
    ripgrep \
    zip \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["sleep", "infinity"]

