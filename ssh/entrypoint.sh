#!/bin/sh
# Boot: generate host keys if absent, materialize the internal config for
# the helpers (sshd scrubs env vars for AuthorizedKeysCommand), then run
# sshd in the foreground.

set -eu

mkdir -p /etc/ssh/keys
if [ ! -f /etc/ssh/keys/ssh_host_ed25519_key ]; then
  ssh-keygen -t ed25519 -f /etc/ssh/keys/ssh_host_ed25519_key -N '' -q
fi
if [ ! -f /etc/ssh/keys/ssh_host_rsa_key ]; then
  ssh-keygen -t rsa -b 3072 -f /etc/ssh/keys/ssh_host_rsa_key -N '' -q
fi

cat > /srv/nixre-env.sh <<EOF
CORE_URL='${CORE_URL:-http://nixre-core:3002}'
INTERNAL_TOKEN='${INTERNAL_TOKEN:-}'
REPOS_ROOT='${REPOS_ROOT:-/data/repos}'
EOF
# Readable by the git user (AuthorizedKeysCommandUser): contains only the
# internal token, which never leaves the docker network.
chmod 644 /srv/nixre-env.sh

mkdir -p /run/sshd /data/repos
# Same uid as nixre-core. A root-owned bind mount would block new spaces.
chown -R 1000:1000 /data/repos || true
chmod u+rwx,g+rwxs /data/repos || true
exec /usr/sbin/sshd -D -e
