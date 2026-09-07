#!/usr/bin/env bash
# One-time bootstrap only. Does not pull, migrate, restart core, or run an update.
set -euo pipefail
NIXRE_DIR="${NIXRE_DIR:-/opt/nixre}"
NIXRE_NODE="${NIXRE_NODE:-$(command -v node)}"
if [ "$(id -u)" -ne 0 ]; then echo 'Run this installer with sudo.' >&2; exit 1; fi
if [[ ! "$NIXRE_DIR" =~ ^/[a-zA-Z0-9_./-]+$ ]] || [[ ! "$NIXRE_NODE" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
  echo 'Use absolute paths without spaces or shell metacharacters.' >&2; exit 1
fi
NIXRE_DIR="$(realpath "$NIXRE_DIR")"
"$NIXRE_NODE" -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
command -v flock >/dev/null
command -v systemctl >/dev/null
docker compose version >/dev/null
if [ ! -d "$NIXRE_DIR/.git" ]; then echo 'A normal Git checkout is required.' >&2; exit 1; fi
if [ -n "$(git -c safe.directory="$NIXRE_DIR" -C "$NIXRE_DIR" status --porcelain)" ]; then
  echo 'Preserve uncommitted changes before installing.' >&2; exit 1
fi
update_owner="$(stat -c %u "$NIXRE_DIR")"
update_group="$(stat -c %g "$NIXRE_DIR")"
socket_group="$(stat -c %g /var/run/docker.sock)"
update_state="$NIXRE_DIR/data/updater"
if systemctl is-active --quiet nixre-updater.service; then
  # Atomically stop accepting work only if idle. Never interrupt a pipeline to
  # replace its worker, and never pass the key through argv or print it.
  "$NIXRE_NODE" - "$NIXRE_DIR" <<'NODE'
const fs = require('node:fs');
const http = require('node:http');
const root = process.argv[2];
const key = fs.readFileSync(root + '/data/update-control/key', 'utf8').trim();
const req = http.request({ socketPath: root + '/data/update-control/control.sock', path: '/shutdown',
  method: 'POST', headers: { Authorization: 'Bearer ' + key } }, res => {
  res.resume(); res.on('end', () => { if (res.statusCode !== 200) { console.error('Worker is busy or needs recovery; installation stopped.'); process.exitCode = 1; } });
});
req.setTimeout(5000, () => req.destroy(new Error('Worker did not respond.')));
req.on('error', () => { console.error('Could not stop the idle worker safely.'); process.exitCode = 1; });
req.end();
NODE
  systemctl stop nixre-updater.service
fi
if [ -f "$update_state/state.json" ]; then
  "$NIXRE_NODE" - "$update_state/state.json" <<'NODE'
const fs = require('node:fs');
const jobs = JSON.parse(fs.readFileSync(process.argv[2])).jobs;
if (jobs.some(j => ['checking', 'running', 'recovery_required'].includes(j.status))) {
  console.error('An update is active or recovery is required. Resolve it before reinstalling the worker.'); process.exit(1);
}
NODE
fi
install -d -m 0755 /usr/local/lib/nixre-updater
install -m 0644 "$NIXRE_DIR"/scripts/updater/*.mjs /usr/local/lib/nixre-updater/
install -d -o "$update_owner" -g "$update_group" -m 0700 "$update_state"
install -d -o "$update_owner" -g 1000 -m 2750 "$NIXRE_DIR/data/update-control"
install -d -o "$update_owner" -g 1000 -m 2755 "$NIXRE_DIR/data/update-status"
install -d -o "$update_owner" -g "$update_group" -m 0755 "$NIXRE_DIR/data/update-web"
if [ ! -f "$NIXRE_DIR/data/update-control/key" ]; then
  (umask 077; "$NIXRE_NODE" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$NIXRE_DIR/data/update-control/key")
fi
chown "$update_owner":1000 "$NIXRE_DIR/data/update-control/key"
chmod 0640 "$NIXRE_DIR/data/update-control/key"
if [ ! -e "$NIXRE_DIR/data/update-web/current" ]; then
  update_revision="$(git -c safe.directory="$NIXRE_DIR" -C "$NIXRE_DIR" rev-parse HEAD)"
  install -d -m 0755 "$NIXRE_DIR/data/update-web/releases/$update_revision"
  cp -a "$NIXRE_DIR/ui/dist/." "$NIXRE_DIR/data/update-web/releases/$update_revision/"
  printf '\n<!-- nixre-updater:%s -->\n' "$update_revision" >> "$NIXRE_DIR/data/update-web/releases/$update_revision/index.html"
  ln -s "releases/$update_revision" "$NIXRE_DIR/data/update-web/current"
  chown -R "$update_owner:$update_group" "$NIXRE_DIR/data/update-web"
fi
cat > /etc/systemd/system/nixre-updater.service <<UNIT
[Unit]
Description=Nixre safe update worker
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
User=$update_owner
Group=$update_group
SupplementaryGroups=$socket_group
WorkingDirectory=$NIXRE_DIR
Environment=NIXRE_DIR=$NIXRE_DIR
Environment=NPM_CONFIG_CACHE=$update_state/npm-cache
EnvironmentFile=-/etc/nixre-updater.env
ExecStart=/usr/bin/flock -n $update_state/daemon.lock $NIXRE_NODE /usr/local/lib/nixre-updater/server.mjs
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=20
UMask=0022
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable nixre-updater.service
systemctl restart nixre-updater.service
echo 'Worker installed. Finish the core mount and Caddy routing bootstrap in docs/instance-updates.md, then use Admin → Instance updates.'
