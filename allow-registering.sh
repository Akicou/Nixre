#!/usr/bin/env bash
# allow-registering.sh — reopen signups on this Nixre instance.
#
# Sets NIXRE_REGISTRATION_CLOSED=false in /opt/nixre/.env and recreates the
# nixre-core container. POST /api/v1/register accepts new accounts again.
#
# Safe to run from anywhere; it operates on /opt/nixre.

set -euo pipefail

NIXRE_DIR="/opt/nixre"
ENV_FILE="$NIXRE_DIR/.env"

log() { printf "[%s] %s\n" "$(date "+%Y-%m-%d %H:%M:%S")" "$*"; }

cd "$NIXRE_DIR"

if grep -q "^NIXRE_REGISTRATION_CLOSED=" "$ENV_FILE" 2>/dev/null; then
  sed -i "s/^NIXRE_REGISTRATION_CLOSED=.*/NIXRE_REGISTRATION_CLOSED=false/" "$ENV_FILE"
else
  printf "\nNIXRE_REGISTRATION_CLOSED=false\n" >> "$ENV_FILE"
fi
log "NIXRE_REGISTRATION_CLOSED=false written to $ENV_FILE"

log "Recreating nixre-core (brief API interruption)…"
docker compose up -d nixre-core >/dev/null

# Core needs a moment to bind its port; wait for /healthz before verifying.
healthy=0
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  log "ERROR: core did not answer /healthz within 60s — check docker logs nixre-core." >&2
  exit 1
fi

code="$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "{}" https://git.nayhein.com/api/v1/register)"
if [ "$code" = "400" ]; then
  log "Registration is open (POST /api/v1/register -> 400 validation, endpoint live)."
else
  log "WARNING: register endpoint answered $code, expected 400 — check docker logs nixre-core." >&2
  exit 1
fi
