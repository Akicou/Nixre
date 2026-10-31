# Safe instance updates

Admin → **Instance updates** → **Check for updates** fetches the configured GitHub `main` revision. Review the commit, files, new migrations, and CI status. Acknowledge the maintenance window and choose **Back up and update**. Updates run on demand, not on a schedule.

Only an administrator's browser session can check or start updates. Personal access tokens, including agent sandbox tokens, are rejected. The browser cannot select a command, remote, branch, Compose file, database, or backup path. Automatic updates support only the local Compose PostgreSQL service with matching PG settings. An external `DATABASE_URL` needs a manual upgrade. The worker pins the resolved deployment configuration and clears connection URLs for the rehearsal.

## One-time bootstrap

Install this feature through your normal manual upgrade first: merge it, preserve local work, fast-forward the production checkout, rebuild `nixre-core`, and apply the tracked Compose/Caddy additions. Do this in a maintenance window.

Requirements: Linux with systemd, Git, `flock`, Docker with Compose v2, Node **22** (match CI), and a clean `main` checkout with its expected `origin`. The checkout owner must be able to use Docker. The worker runs as that account, so its Docker access is host-administrative. Do not grant the control socket/key to ordinary users or agent containers.

From a clean, current checkout:

```bash
sudo env NIXRE_DIR=/opt/nixre NIXRE_NODE=/usr/bin/node bash /opt/nixre/scripts/install-updater.sh
```

The installer copies the worker to `/usr/local/lib/nixre-updater`, creates its private key and state directories, seeds the managed UI release, and starts an idle systemd service. It does not deploy or migrate.

For **Docker Caddy**, the tracked Compose file mounts the control directory read-only into core, and only the observation socket and managed UI into web. Apply the mounts and reload Caddy:

```bash
cd /opt/nixre
docker compose config --quiet
docker compose up -d --build nixre-core
docker compose up -d --force-recreate nixre-web
```

For **host `caddy.service`**, keep your hostname, TLS, tunnel, security headers, and API proxy. Add this route before the SPA fallback, and change the SPA root:

```caddyfile
handle /update-status/* {
    reverse_proxy unix//opt/nixre/data/update-status/status.sock
}
# Inside the existing SPA fallback handle:
root * /opt/nixre/data/update-web/current
```

Validate the host Caddy configuration before reloading. Do not replace a production site block with the container `:3000` Caddyfile. Recreate core with the read-only `data/update-control` mount and supplemental group 1000. Do not start Docker `nixre-web` if host Caddy owns port 3000.

The worker probes `http://127.0.0.1:3000`. If your host edge uses another local port, set `NIXRE_UPDATE_PUBLIC_URL=http://127.0.0.1:PORT` in `/etc/nixre-updater.env`, then restart `nixre-updater`. That endpoint must serve the managed SPA and `/update-status/health`. The worker checks the served release marker before cutover.

Optional worker-only settings in that root-controlled file:

- `NIXRE_UPDATE_REPOSITORY=Akicou/Nixre`: trusted repository. The checkout origin must match it exactly.
- `NIXRE_UPDATE_GITHUB_TOKEN`: read-only GitHub token for rate limits or private forks. Keep it out of the browser and out of commits.

## Pipeline and failure boundaries

1. Recheck the reviewed base/target SHA and Compose/environment fingerprint. Require the latest `push` CI run for that `main` SHA to pass. Refuse dirty, ahead, diverged, non-main, or unexpected-origin checkouts. Reviews expire after ten minutes.
2. Build from a detached worktree. Run UI install, tests, and build in a Node 22 container with no host secrets or Docker socket. Require `ui/dist` to match the commit. Build separate backend/sandbox images without touching running containers. Git hooks are disabled.
3. Dump PostgreSQL (custom format), restore into a disposable database with no published ports, and run the candidate migration runner there. Compare every applied migration filename with the candidate files. Production keeps serving.
4. Pause new HTTP mutations, reject active agents/deployments, recheck checkout/configuration/CI, and stop core and SSH. Take a final dump and verify its archive structure.
5. Run migrations against production in the runner's transaction. Record the failed filename and SQLSTATE (no raw SQL, credentials, or driver errors).
6. Start the candidate backend, verify database-backed health and exact revision, fast-forward the checkout, atomically switch the managed UI symlink, verify its revision through Caddy, and restart SSH.

A failure before production migrations leaves the database unchanged. If services were paused, the previous backend image and SSH are restored and health-checked. A confirmed transaction rollback allows the same recovery. If COMMIT succeeded, its result is uncertain, or the worker restarted mid-operation, automatic rollback is blocked. Core/SSH may stay stopped and HTTP mutations paused until an operator recovers the instance. **There is no automatic destructive database restore.**

Compose, Caddy, SSH, host-worker, and entrypoint changes, and edits to existing migrations, need a manual upgrade. SQL migrations must be append-only and transaction-safe. The pipeline does not roll back external side effects, deployed applications, repository writes, or third-party services.

## Progress, backups, and recovery

`/update-progress` works while core or PostgreSQL is down. It uses a 24-hour read-only observation token kept in this tab's `sessionStorage`, sent in an Authorization header, never in URLs. Reconnect from Admin to authorize another tab or renew access. If Caddy or the worker is unavailable, the page shows connection loss and retries.

State and the latest 20 job records persist in `data/updater/state.json`. The UI shows stages, migration outcome, backup location, log location, and recovery-required errors. Raw build/driver output stays in host-only `data/updater/<job-id>.log` and is never served by the observation API. Treat logs and dumps as sensitive. The updater never prunes backups, recovery inventory, candidate worktrees, or old images. Remove old artifacts manually, only after verifying a successful update and your independent backups.

After a failure:

1. Read the failed stage in the progress page. On the host, inspect `systemctl status nixre-updater`, the private job log, and the run directory's `recovery.json`, `previous.compose.json`, and `final.dump`. Preserve the current database and repository data before any recovery attempt.
2. For a committed or uncertain migration, either fix forward or restore the saved database with the matching previous application image. Keep core and SSH stopped during database recovery. Restoring a dump replaces data and must be an explicit operator decision. Follow PostgreSQL restore procedures for your installation.
3. Verify that the database, migration versions, `/healthz`, running image, SSH, Git checkout, and `data/update-web/current` agree. Preserve local commits; never reset them away. Use the retained previous image override to recreate old core only after database compatibility is established.
4. Stop the worker and acknowledge recovery **only after** those checks:

```bash
sudo systemctl stop nixre-updater
sudo env NIXRE_DIR=/opt/nixre /usr/bin/node /usr/local/lib/nixre-updater/server.mjs --ack-recovery --services-verified
sudo systemctl start nixre-updater
```

The acknowledgement clears the maintenance flag and unlocks future checks. It does not restore a database, change a Git ref, or restart services.

For a later **manual infrastructure upgrade**, verify no update is active and stop the host worker. Preserve its state/backups and keep using `git merge --ff-only`. Rebuild/recreate the affected services and publish the matching managed UI release. Reinstall the copied worker if its code changed. `update-nixre.sh` refuses to run while the managed updater key exists. Do not delete the key to bypass that guard.
