# Administration & server operations

## Users, registration, admin

- **First account = admin.** Admin endpoints: `GET/PATCH /api/v1/admin/users`, `POST /api/v1/admin/registration` (open/close self-service register).
- **Registration is closed** by default (an unset `NIXRE_REGISTRATION_CLOSED` means closed; set it to `false` to open). `true` makes `POST /api/v1/register` return 403. Flip it live with `PUT /api/v1/admin/registration`. Add users by flipping the switch (then having them register), or insert/update the user directly in the DB.
- Account-level flags: `account_admin`, `account_blocked`.

## Updating nixre

### Managed updater (preferred when installed)

Admin → **Instance updates** → *Check for updates* reviews the configured GitHub `main` revision (commit, files, new migrations, CI), then *Back up and update* runs an on-demand pipeline: build in a detached worktree, rehearse the migrations on a restored dump, pause writes, take a final dump, migrate, cut over, verify. Only an admin **browser session** can start it (PATs and agent sandbox tokens are rejected). A worker (`nixre-updater.service`) owns the checkout, so `update-nixre.sh` refuses to run on such an install.

- Core then runs from a per-revision image tag (`nixre-update-core:<git-sha>`). To restart core for an `.env` change without losing that identity: `NIXRE_CORE_IMAGE=$(docker inspect nixre-core --format '{{.Config.Image}}') docker compose up -d --no-build nixre-core`, then `curl -sf http://127.0.0.1:3001/healthz`.
- Failure before production migrations leaves the DB unchanged and restores the previous backend. After a committed or uncertain migration there is **no automatic destructive restore**; core may stay stopped until an operator recovers.
- Compose/Caddy/SSH/worker changes and edits to existing migrations need a manual upgrade. Full reference: `docs/instance-updates.md`; key and network changes: `docs/security-upgrade.md`.

### Manual: `update-nixre.sh`

`update-nixre.sh` (at the repo root) is the safe path:

1. `git fetch`; **fast-forward** the current branch to origin (never `reset --hard`; aborts with instructions on divergence, preserving local commits).
2. Re-applies the host port mapping (core → `127.0.0.1:3001`) when running the host-Caddy variant.
3. `npm install` + build the SPA (`ui/dist`).
4. Rebuild/restart `nixre-agent-sandbox`, `nixre-db`, `nixre-core`, `nixre-ssh`.
5. Waits for core to answer `/healthz`.

```bash
./update-nixre.sh
```

**To push your local commits:** if the host has no shell GitHub credential, push from a machine with creds: `git push origin <branch>`.

## Backups

Two things to back up: the Postgres DB and the git repo volume.

```bash
./scripts/nixre-backup.sh /var/tmp/nixre-backup
```

The script dumps `nixre-db` (`pg_dump`) and tars `./data/repos`. Restore:

```bash
# postgres
docker exec -i nixre-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < backup.dump   # values from .env
# repos
tar xzf repos.tar.gz -C <nixre-dir>/data/
```

## Logs

```bash
docker logs -f nixre-core                 # backend logs (SSE, build, errors)
./scripts/nixre-logs.sh                   # same
docker logs -f nixre-ssh                  # sshd / git-shell
```

**First place to look when a UI feature misbehaves:** `docker logs nixre-core`. Recent bugs (NaN bigint, param-name mismatch) were backend crashes that only surfaced in logs.

## DB access

```bash
docker exec -it nixre-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"   # values from .env
```

Tables of note: `users`, `sessions`, `spaces`, `repos`, `pull_requests`, `webhooks`, `deploy_services`, `service_env_vars`, `deploy_domains` (+ `cf_zone_id`/`cf_record_id`), `conversations`, `ai_providers`, `ai_provider_profiles`, `plugins`, `issues`, `issue_comments`, `security_scans`.

## Security scan

Nixre scans itself (on by default, every 3 hours; admin setting 1–168 h). It inventories `nixre-core` and every running deployment through the Docker API using a fixed, exact-match allowlist of read-only commands (no shell), checks packages against OSV and Node.js against nodejs.org's release index, then has an admin's configured **Assistant provider** triage. The model may only `create_issue` in a repo that owns a scanned deployment (plus the optional *instance repo* for `nixre-core` findings) and `dispatch_workflow` a `workflow_dispatch` workflow in those repos (max 3 per scan).

- One issue per root cause; a rerun reopens it if closed while the problem persists. Findings are hashed: unchanged since last scan → the model is not called (`skipped`).
- No provider configured → the scan still runs and keeps its report but files nothing. Pick provider/model under **Admin → Security scan**.
- API (admin only): `GET/PUT /api/v1/admin/security-scan` (`enabled`, `intervalHours`, `providerId`, `model`, `coreRepo`), `POST /admin/security-scan/run`, `GET /admin/security-scan/runs/:id`.
- Limits: distroless/scratch images yield no packages; OSV covers language packages and Alpine/Debian only. The scan never changes a container. Full reference: `docs/security-scan.md`.

## TLS / Cloudflare notes

- Look up your Cloudflare zone ID in the Cloudflare dashboard, and set the token in `.env` (`CLOUDFLARE_API_TOKEN`). It needs **`Zone:Read` + `DNS:Edit`** on every zone domains are attached from — a read-only token makes auto-DNS fail. Automatic CNAMEs are admin-only and never overwrite a conflicting record; other users publish TXT proof (`_nixre-verify.<domain>`) and configure DNS themselves. Remove stale/read-only tokens from the Cloudflare dashboard.
- Universal SSL covers the apex + one level (`<your-domain>` + `*.<your-domain>`) only. Keep domain labels hyphenated (no dots).

## Frontend nuance

- The SPA is often served by **host Caddy** from `<nixre-dir>/ui/dist`, not the `nixre-web` container.
- Cache headers in Caddy: `/index.html` → `no-cache, max-age=0`; `/assets/*` → immutable 1 year. A matcher-first header block silently no-ops if you write path-after-value; use the one-liner `header /index.html Cache-Control "..."`.
- If the browser shows stale UI, `Ctrl+Shift+R` (hard reload) — the no-cache header prevents it mostly, but an old service worker or memory-cached page can linger.

## Service lifecycle

```bash
cd <nixre-dir>
docker compose ps                     # status
docker compose logs -f nixre-core     # logs
systemctl --user status cloudflared-<name>   # tunnel
systemctl --user restart cloudflared-<name>  # restart tunnel
```
