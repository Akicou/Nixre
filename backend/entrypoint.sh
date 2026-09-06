#!/bin/sh
# Bind-mounted ./data/repos hides the image's chown and is often root-owned
# on the host. Core and ssh share the volume as uid 1000. Fix ownership
# before dropping privileges, otherwise mkdir of a new space (e.g.
# /data/repos/<space>) fails with EACCES.
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

# Docker socket access for agent sandboxes (run_command).
RUN_AS="1000:1000"
if [ -S /var/run/docker.sock ]; then
  DG="${DOCKER_GID:-$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo '')}"
  case "$DG" in
    ''|*[!0-9]*)
      echo "nixre-core: Docker socket group must be a numeric GID" >&2
      exit 1
      ;;
  esac
  # The GID may already belong to node (1000), root (0), or another group.
  # su-exec accepts numeric IDs; no named group needs to be created. Keep the
  # application UID unprivileged while retaining the socket's required group.
  RUN_AS="1000:$DG"
fi

exec su-exec "$RUN_AS" "$@"
