#!/usr/bin/env bash
# update-nixre.sh — pull the latest Nixre, rebuild the UI, and redeploy the
# backend containers. Safe to run from anywhere; it operates on /opt/nixre.
#
#   ./update-nixre.sh
#
# What it does:
#   1. git fetch; fast-forward the CURRENT branch to its origin counterpart
#      (never discards local commits — aborts with instructions on divergence)
#   2. re-applies the host-specific port mapping (core -> 127.0.0.1:3001)
#   3. npm install + build the SPA (ui/dist)
#   4. rebuild + restart sandbox image + nixre-db / nixre-core / nixre-ssh
#   5. waits for core to answer /healthz
#
# The frontend is served by the host caddy.service (not the docker nixre-web
# container), so only the three backend services are managed here.

set -euo pipefail

NIXRE_DIR="/opt/nixre"
COMPOSE_SERVICES="nixre-agent-sandbox nixre-db nixre-core nixre-ssh"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Make node/npm available (nvm is loaded per-shell, not in non-interactive ssh).
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi

if [ ! -d "$NIXRE_DIR/.git" ]; then
  log "ERROR: $NIXRE_DIR is not a git checkout." >&2
  exit 1
fi

cd "$NIXRE_DIR"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
log "Fetching latest code for branch '${BRANCH}'…"
git fetch origin --prune

if git rev-parse --verify --quiet "origin/${BRANCH}" >/dev/null; then
  local_head="$(git rev-parse HEAD)"
  remote_head="$(git rev-parse "origin/${BRANCH}")"
  if [ "$local_head" = "$remote_head" ]; then
    log "Already up to date (${BRANCH} @ $(git rev-parse --short HEAD))."
  elif git merge-base --is-ancestor "$local_head" "$remote_head"; then
    # Strictly behind origin: safe to fast-forward.
    git reset --hard "origin/${BRANCH}"
    log "Fast-forwarded ${BRANCH} to $(git rev-parse --short HEAD)."
  elif git merge-base --is-ancestor "$remote_head" "$local_head"; then
    # Local commits not yet pushed: keep them, warn the operator.
    log "WARNING: ${BRANCH} is $(git rev-list --count "origin/${BRANCH}..HEAD") commits ahead of origin — keeping local commits."
    log "         Push them when credentials are available: git push origin ${BRANCH}"
  else
    log "ERROR: ${BRANCH} diverged from origin — refusing to reset (local commits would be lost)." >&2
    log "       Resolve manually: git pull --rebase origin ${BRANCH} (or push first), then re-run."
    exit 1
  fi
else
  log "WARNING: no origin/${BRANCH} on the remote — building the current checkout ($(git rev-parse --short HEAD))."
fi

# Host-specific: the system caddy (caddy.service) reverse-proxies to
# 127.0.0.1:3001, so keep core mapped there instead of the committed 3002.
# (No-op when the checkout already carries the 3001 mapping.)
log "Applying host port mapping (core -> 127.0.0.1:3001)…"
sed -i 's/127\.0\.0\.1:3002:3002/127.0.0.1:3001:3002/' docker-compose.yml

log "Installing UI dependencies…"
( cd ui && npm install )

log "Building UI (tsc + vite)…"
( cd ui && npm run build )

log "Rebuilding and restarting containers (${COMPOSE_SERVICES})…"
docker compose up -d --build ${COMPOSE_SERVICES}

log "Pruning dangling images…"
docker image prune -f >/dev/null 2>&1 || true

log "Waiting for core to become healthy…"
healthy=0
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done

if [ "$healthy" -eq 1 ]; then
  log "Core is healthy."
else
  log "WARNING: core did not answer /healthz within 60s — check 'docker logs nixre-core'." >&2
fi

log "Done. Running commit: $(git rev-parse --short HEAD)"
