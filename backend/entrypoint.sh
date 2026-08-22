#!/bin/sh
# Bind-mounted ./data/repos hides the image's chown and is often root-owned
# on the host. Core and ssh share the volume as uid 1000. Fix ownership
# before dropping privileges, otherwise mkdir of a new space (e.g.
# /data/repos/Nayhein) fails with EACCES.
set -eu

ROOT="${REPOS_ROOT:-/data/repos}"
mkdir -p "$ROOT"

if ! su-exec 1000:1000 test -w "$ROOT" 2>/dev/null; then
  chown -R 1000:1000 "$ROOT" || true
  chmod u+rwx,g+rwxs "$ROOT" || true
fi

if ! su-exec 1000:1000 test -w "$ROOT"; then
  echo "nixre-core: $ROOT is not writable by uid 1000. On the host: chown -R 1000:1000 data/repos" >&2
  exit 1
fi

exec su-exec 1000:1000 "$@"
