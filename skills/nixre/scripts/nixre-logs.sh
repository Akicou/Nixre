#!/usr/bin/env bash
# nixre-logs.sh [app|ssh] — tail nixre-core logs, optionally adding the deploy
# proxy (app traffic) or the ssh container.
#
#   ./nixre-logs.sh          # follow nixre-core
#   ./nixre-logs.sh app      # nixre-core + deploy proxy traffic
#   ./nixre-logs.sh ssh      # nixre-core + nixre-ssh
set -uo pipefail

NIXRE_DIR="${NIXRE_DIR:-$(pwd)}"
which="${1:-core}"

cd "$NIXRE_DIR" || { echo "! cannot cd $NIXRE_DIR" >&2; exit 1; }

case "$which" in
  app|deploy)
    echo "Tailing nixre-core (the deploy proxy runs inside it on :3003)… Ctrl-C to stop"
    docker compose logs --tail=200 -f nixre-core ;;
  ssh)
    echo "Tailing nixre-core + nixre-ssh…"
    docker compose logs --tail=200 -f nixre-core &
    docker compose logs --tail=200 -f nixre-ssh &
    wait ;;
  *)
    echo "Tailing nixre-core…"
    docker compose logs --tail=200 -f nixre-core ;;
esac
