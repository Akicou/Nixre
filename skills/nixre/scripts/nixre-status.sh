#!/usr/bin/env bash
# nixre-status.sh — a 10-second overview of this Nixre instance.
# Shows container health, core /healthz, the Cloudflare tunnel, and the SPA.
# No changes are made; this is read-only diagnostics.
set -uo pipefail

NIXRE_DIR="${NIXRE_DIR:-/opt/nixre}"
CORE_URL="${CORE_URL:-http://127.0.0.1:3001/healthz}"
SPA_URL="${SPA_URL:-https://git.nixre.dev/}"
TUNNEL_ID="${TUNNEL_ID:-5f0d7f1f-fa8c-42cf-ac2e-7f602d0f6688}"

log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
sect() { printf '\n== %s ==\n' "$*"; }

sect "Containers"
if cd "$NIXRE_DIR" 2>/dev/null; then
  docker compose ps 2>&1 | sed 's/^/  /'
else
  echo "  ! cannot cd $NIXRE_DIR"
fi

sect "nixre-core /healthz"
if body="$(curl -fsS --max-time 3 "$CORE_URL" 2>/dev/null)"; then
  echo "  OK  $CORE_URL -> $body"
else
  echo "  FAIL $CORE_URL (no response)"
fi

sect "Cloudflare tunnel (user service)"
if systemctl --user is-active --quiet cloudflared-nixre 2>/dev/null; then
  echo "  ACTIVE cloudflared-nixre (tunnel $TUNNEL_ID)"
elif systemctl is-active --quiet cloudflared 2>/dev/null; then
  echo "  ACTIVE cloudflared (system service)"
else
  echo "  INACTIVE  cloudflared-nixre"
fi
systemctl --user status cloudflared-nixre --no-pager 2>/dev/null | sed -n '1,4p' | sed 's/^/  /'

sect "SPA / git.nixre.dev"
if body="$(curl -fsS --max-time 5 "$SPA_URL" 2>/dev/null)"; then
  if hash="$(printf '%s' "$body" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)"; then
    echo "  OK  served bundle: $hash"
  else
    echo "  OK  SPA reachable (no asset hash found)"
  fi
else
  echo "  FAIL $SPA_URL"
fi

sect "SSH endpoint"
ssh -p 3022 -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=no git@ssh.nixre.dev 2>&1 | head -1 | sed 's/^/  /'

echo
log "done. For deeper logs: ${BASH_SOURCE[0]%/*}/nixre-logs.sh"
