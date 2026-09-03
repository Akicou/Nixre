# Administration & server operations

## Users, registration, admin

- **First account = admin.** Admin endpoints: `GET/PATCH /api/v1/admin/users`, `POST /api/v1/admin/registration` (open/close self-service register).
- **Registration is closed** on this instance: `NIXRE_REGISTRATION_CLOSED=true` in `.env` makes `POST /api/v1/register` return 403. Add users by flipping the switch (then having them register), or insert/update the user directly in the DB.
- Admin user uid on this instance: `Lyan`. Account-level flags: `account_admin`, `account_blocked`.

## Updating nixre

`/opt/nixre/update-nixre.sh` is the safe path:

1. `git fetch`; **fast-forward** the current branch to origin (never `reset --hard`; aborts with instructions on divergence, preserving local commits).
2. Re-applies the host port mapping `core -> 127.0.0.1:3001`.
3. `npm install` + build the SPA (`ui/dist`).
4. Rebuild/restart `nixre-agent-sandbox`, `nixre-db`, `nixre-core`, `nixre-ssh`.
5. Waits for core to answer `/healthz`.

```bash
cd /opt/nixre && ./update-nixre.sh
```

**To push your local commits:** the `feat/deployments` branch is ahead of origin. There is no shell GitHub credential on the server, so push from a machine with creds: `git push origin feat/deployments`.

## Backups

Two things to back up: the Postgres DB and the git repo volume.

```bash
./scripts/nixre-backup.sh /var/tmp/nixre-backup
```

The script dumps `nixre-db` (`pg_dump`) and tars `./data/repos`. Restore:

```bash
# postgres
docker exec -i nixre-db psql -U nixre -d nixre < backup.dump
# repos
tar xzf repos.tar.gz -C /opt/nixre/data/
```

## Logs

```bash
docker logs -f nixre-core                 # backend logs (SSE, build, errors)
./scripts/nixre-logs.sh                   # same
./scripts/nixre-logs.sh deploy            # + deploy proxy / app-routing logs
docker logs -f nixre-ssh                  # sshd / git-shell
```

**First place to look when a UI feature misbehaves:** `docker logs nixre-core`. Recent bugs (NaN bigint, param-name mismatch) were backend crashes that only surfaced in logs.

## DB access

```bash
docker exec -it nixre-db psql -U nixre -d nixre
```

Tables of note: `users`, `sessions`, `spaces`, `repos`, `pull_requests`, `webhooks`, `deploy_services`, `service_env_vars`, `deploy_domains` (+ `cf_zone_id`/`cf_record_id`), `conversations`, `ai_providers`, `ai_provider_profiles`, `plugins`.

## TLS / Cloudflare notes

- Zone `nixre.dev` → `cd4a6e30734851f0b76fa6cca5afa3d7`.
- Cloudflare token is set in `.env` (`CLOUDFLARE_API_TOKEN`). It needs **`Zone:Read` + `DNS:Edit`** on every zone users attach domains from — the first token created lacked `DNS:Edit`, which made auto-DNS fail. Remove stale/read-only tokens from the Cloudflare dashboard.
- Universal SSL covers `nixre.dev` + `*.nixre.dev` only. Keep domain labels hyphenated (no dots).

## Frontend nuance

- The SPA is served by **host Caddy** from `/opt/nixre/ui/dist`, not the `nixre-web` container.
- Cache headers in Caddy: `/index.html` → `no-cache, max-age=0`; `/assets/*` → immutable 1 year. A matcher-first header block silently no-ops if you write path-after-value; use the one-liner `header /index.html Cache-Control "..."`.
- If the browser shows stale UI, `Ctrl+Shift+R` (hard reload) — the no-cache header prevents it mostly, but an old service worker or memory-cached page can linger.

## Service lifecycle

```bash
cd /opt/nixre
docker compose ps                     # status
docker compose logs -f nixre-core     # logs
systemctl --user status cloudflared-nixre   # tunnel
systemctl --user restart cloudflared-nixre  # restart tunnel
```
