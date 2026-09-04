#!/usr/bin/env bash
# nixre-status.sh — a 10-second overview of a Nixre instance.
# Shows container health, core /healthz, the Cloudflare tunnel, and the SPA.
# No changes are made; this is read-only diagnostics.
#
# Set these to match your instance (or via env):
#   NIXRE_DIR  - source dir            (default: current dir)
#   CORE_URL   - core health check     (default: http://127.0.0.1:3001/healthz)
#   SPA_URL    - public SPA URL        (default: unset -> skipped)
#   TUNNEL_NAME - cloudflared service  (default: cloudflared)
set -uo pipefail

NIXRE_DIR="${NIXRE_DIR:-$(pwd)}"
CORE_URL="${CORE_URL:-http://127.0.0.1:3001/healthz}"
SPA_URL="${SPA_URL:-}"
TUNNEL_NAME="${TUNNEL_NAME:-cloudflared}"

log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
sect() { printf '\n== %s ==\n' "$*"; }

sect "Containers"
if cd "$NIXRE_DIR" 2>/dev/null; then
  docker compose ps 2>&1 | sed 's/^/  /'
else
  echo "  ! cannot cd $NIXRE_DIR"
fi

sect "nixre-core /healthz"
if curl -fsS --max-time 3 "$CORE_URL" 2>/dev/null; then
  echo "  OK  $CORE_URL"
else
  echo "  FAIL $CORE_URL (no response)"
fi

sect "Cloudflare tunnel"
if systemctl --user is-active --quiet "$TUNNEL_NAME" 2>/dev/null; then
  echo "  ACTIVE $TUNNEL_NAME (user service)"
elif systemctl is-active --quiet "$TUNNEL_NAME" 2>/dev/null; then
  echo "  ACTIVE $TUNNEL_NAME (system service)"
else
  echo "  INACTIVE  $TUNNEL_NAME"
fi

if [ -n "$SPA_URL" ]; then
  sect "SPA ($SPA_URL)"
  if body="$(curl -fsS --max-time 5 "$SPA_URL" 2>/dev/null)"; then
    if hash="$(printf '%s' "$body" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)"; then
      echo "  OK  served bundle: $hash"
    else
      echo "  OK  SPA reachable (no asset hash found)"
    fi
  else
    echo "  FAIL $SPA_URL"
  fi
fi

echo
log "done. For deeper logs: ${BASH_SOURCE[0]%/*}/nixre-logs.sh"
