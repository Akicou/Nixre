# Safe instance updates

Admin → **Instance updates** → **Check for updates** fetches the configured GitHub `main` revision. Review the commit, files, new migrations, and passing CI; acknowledge the maintenance window and choose **Back up and update**. This starts an on-demand automatic pipeline, not an unattended schedule.

Only an administrator's browser session can check or start updates. Personal access tokens, including agent sandbox tokens, are rejected. The browser cannot select a command, remote, branch, Compose file, database, or backup path. Automatic updates currently support the local Compose PostgreSQL service with matching PG settings; external `DATABASE_URL` installations require a manual upgrade. The worker pins the resolved deployment configuration and explicitly clears connection URLs for the rehearsal.

## One-time bootstrap

This feature must first be installed through your normal manual upgrade process. The old backend cannot install its own independent host service. Merge the feature, preserve local work, fast-forward the production checkout, rebuild `nixre-core`, and apply the tracked Compose/Caddy additions. Do this during a planned maintenance window.

Requirements: Linux with systemd, Git, `flock`, Docker with Compose v2, Node **22** (match CI for reproducible UI builds), and a clean `main` checkout with its expected `origin`. The checkout owner must be able to use Docker. The worker uses that host account; its Docker access is host-administrative access. Do not grant the control socket/key to ordinary users or agent containers.

From a clean, current checkout:

```bash
sudo env NIXRE_DIR=/opt/nixre NIXRE_NODE=/usr/bin/node bash /opt/nixre/scripts/install-updater.sh
```

The installer copies the worker to `/usr/local/lib/nixre-updater`, creates its private key and state directories, seeds the managed UI release, and starts an idle systemd service. It does not deploy or migrate. The installed worker stays outside the updating checkout so an in-progress update cannot replace its own implementation.

For **Docker Caddy**, the tracked Compose file mounts the control directory read-only into core, and mounts only the observation socket and managed UI into web. Apply those mounts and reload the new Caddy configuration:

```bash
cd /opt/nixre
docker compose config --quiet
docker compose up -d --build nixre-core
docker compose up -d --force-recreate nixre-web
```

For **host `caddy.service`** (the existing host-based installation), keep your hostname, TLS, tunnel, security headers, and API proxy. Add this route before the SPA fallback, and change the SPA root:

```caddyfile
handle /update-status/* {
    reverse_proxy unix//opt/nixre/data/update-status/status.sock
}
# Inside the existing SPA fallback handle:
root * /opt/nixre/data/update-web/current
```

Validate your host Caddy configuration before reloading it. Do not replace a production site block with the container-oriented `:3000` Caddyfile. Recreate core with the new read-only `data/update-control` mount and supplemental group 1000. Do not start Docker `nixre-web` if host Caddy already owns port 3000.

The worker probes `http://127.0.0.1:3000`. If your host edge uses a different local port, set `NIXRE_UPDATE_PUBLIC_URL=http://127.0.0.1:PORT` in `/etc/nixre-updater.env`, then restart `nixre-updater`. This endpoint must serve both the managed SPA and `/update-status/health`. The worker checks the served release marker before cutover.

Optional worker-only settings in that root-controlled environment file:

- `NIXRE_UPDATE_REPOSITORY=Akicou/Nixre`: trusted repository; the checkout origin must match it exactly.
- `NIXRE_UPDATE_GITHUB_TOKEN`: optional read-only GitHub token for rate limits/private forks. Do not put it in the browser or commit it.

## Pipeline and failure boundaries

1. Recheck the exact reviewed base/target SHA and Compose/environment fingerprint. Require the latest `push` CI run for that exact `main` SHA to pass. Refuse dirty, ahead, diverged, non-main, or unexpected-origin checkouts. Reviews expire after ten minutes.
2. Build in a detached worktree. Run the UI tests and build, require `ui/dist` to match the commit, and build separate backend/sandbox images without touching the running containers.
3. Create a custom-format PostgreSQL dump, restore it into a disposable database with no published ports, and run the candidate migration runner there. Compare every applied migration filename with the candidate files. Production keeps serving during this rehearsal.
4. Pause new HTTP mutations, reject active agents/deployments, recheck the checkout/configuration/CI, and stop core and SSH. Take a fresh final database dump and verify its archive structure.
5. Run migrations against production in the migration runner's transaction. Record the failed filename and SQLSTATE without exposing raw SQL, credentials, or driver errors.
6. Start the candidate backend, verify database-backed health and exact revision, fast-forward the checkout, atomically switch the managed UI symlink, verify its revision through Caddy, and restart SSH.

Before production migrations, failure leaves the database unchanged. If services were paused, the previous backend image and SSH are restored and health-checked. A confirmed transaction rollback permits this same recovery. If COMMIT succeeded, its result is uncertain, or the worker restarted mid-operation, automatic rollback is blocked. Core/SSH may remain stopped and HTTP mutations remain paused until an operator recovers the instance. **There is no automatic destructive database restore.**

Compose/Caddy/SSH/host-worker/entrypoint changes and edits to existing migrations require a manual upgrade. SQL migrations must be append-only and transaction-safe. Rehearsal is a strong check, not proof that arbitrary application changes are correct. The pipeline does not roll back external side effects, deployed applications, repository writes, or third-party services.

## Progress, backups, and recovery

`/update-progress` loads without the normal core login bootstrap. It uses a 24-hour, read-only observation capability stored in this tab's `sessionStorage`; it works while core or PostgreSQL is unavailable. Tokens are sent in an Authorization header, never in URLs. Reconnect from Admin to authorize another tab or renew access. If Caddy or the worker itself is unavailable, the page shows connection loss and retries; it never reports an unverified success.

State and the latest 20 job records survive restarts in `data/updater/state.json`. The UI shows stages, migration outcome, verified backup location, private log location, and recovery-required errors. Raw build/driver output stays in host-only `data/updater/<job-id>.log`; it is never served by the observation API. Treat those logs and dumps as sensitive. Backups, recovery inventory, candidate worktrees, and old images are retained; the updater never prunes them. Budget disk space and remove old artifacts manually only after verifying a successful update and your independent backups.

After a failure:

1. Read the failed stage in the progress page. On the host, inspect `systemctl status nixre-updater`, the private job log, and the run directory's `recovery.json`, `previous.compose.json`, and `final.dump`. Preserve the current database and repository data before any recovery attempt.
2. For a committed or uncertain migration, decide whether to fix forward or restore the saved database with the matching previous application image. Keep core and SSH stopped during database recovery. Restoring a dump replaces data and must be an explicit operator decision; consult PostgreSQL backup/restore procedures for your installation.
3. Verify the database, expected migration versions, `/healthz`, running image, SSH, Git checkout, and `data/update-web/current` agree. Preserve local commits; never reset them away. The retained previous image override can recreate old core only after database compatibility is established.
4. Stop the worker and acknowledge recovery **only after** those checks:

```bash
sudo systemctl stop nixre-updater
sudo env NIXRE_DIR=/opt/nixre /usr/bin/node /usr/local/lib/nixre-updater/server.mjs --ack-recovery --services-verified
sudo systemctl start nixre-updater
```

This acknowledgement clears the maintenance flag and unlocks future checks. It does not restore a database, change a Git ref, or restart application services.

For a later **manual infrastructure upgrade**, first verify no update is active and stop the host worker. Preserve its state/backups and keep using `git merge --ff-only`. Rebuild/recreate the affected services and publish the matching managed UI release; reinstall the copied worker if its code changed. `update-nixre.sh` deliberately refuses to run while the managed updater key exists, preventing two independent update paths from overlapping. Do not delete the key merely to bypass that guard.
