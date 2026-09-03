#!/usr/bin/env bash
# nixre-logs.sh [app|ssh] — tail nixre-core logs, optionally adding the deploy
# proxy (app traffic) or the ssh container.
#
#   ./nixre-logs.sh          # follow nixre-core
#   ./nixre-logs.sh app      # nixre-core + deploy proxy traffic
#   ./nixre-logs.sh ssh      # nixre-core + nixre-ssh
set -uo pipefail

NIXRE_DIR="${NIXRE_DIR:-/opt/nixre}"
which="${1:-core}"

cd "$NIXRE_DIR" || { echo "! cannot cd $NIXRE_DIR" >&2; exit 1; }

run() { docker compose logs --tail=200 -f "$1"; }

case "$which" in
  app|deploy)
    echo "Tailing nixre-core + deploy proxy traffic… (Ctrl-C to stop)"
    docker compose logs --tail=200 -f nixre-core & 
    # deploy proxy runs inside nixre-core on :3003, but there's no separate
    # container. All app-routing logs come from nixre-core itself, so the
    # first stream is what you want. If you need raw proxy access, check the
    # DEPLOY_PROXY_PORT logs via `docker logs nixre-core`.
    wait ;;
  ssh)
    echo "Tailing nixre-core + nixre-ssh…"
    docker compose logs --tail=200 -f nixre-core &
    docker compose logs --tail=200 -f nixre-ssh &
    wait ;;
  *)
    echo "Tailing nixre-core…"
    run nixre-core ;;
esac
