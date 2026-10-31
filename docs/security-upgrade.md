# Upgrading existing installations safely

Read this before upgrading from a version before migration 025, or before rotating encryption/database credentials. Keep old encryption material: old database backups need their original keys.

## Maintenance and backups

1. Stop writes from web, SSH, assistant, and deployment clients. Stop core, SSH, and web using the old working configuration. Leave PostgreSQL running for backup and credential rotation. Disable host-managed ingress too.
2. Take a PostgreSQL logical backup, and back up repositories, SSH host keys, sandbox workspace volumes, and private configuration. Store them outside Git with restrictive permissions. Verify a restore to a disposable database.
3. Record the Compose project name and network overrides, and keep the project name. Inventory containers and named volumes. Do not use `down -v`, delete `data/pg`, or remove workspace volumes to fix failures.
4. Preserve local commits and uncommitted changes. The updater refuses dirty checkouts, uses `git merge --ff-only`, and never resets the working tree.

## Database credentials

`POSTGRES_PASSWORD` only initializes a NEW data directory. Changing it in `.env` does not change an existing role's password. Older installations initialized with user/database/password `nixre` need explicit rotation while clients are stopped.

For the standard old installation, open a local administration session (use the actual role/database if customized):

```bash
docker exec -it nixre-db psql -U nixre -d nixre
```

In psql, run `\password nixre` to set the new strong password without exposing it in shell history or SQL, then `\q`. Set the SAME value as `POSTGRES_PASSWORD` in the private `.env`. Do not change `POSTGRES_USER` or `POSTGRES_DB` unless those objects were separately migrated in PostgreSQL.

Compose passes separate `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE` fields. Non-Compose installations may supply `DATABASE_URL` with URI-encoded credentials. A healthy `pg_isready` does not prove the application credentials work.

## Encryption and sessions

New ciphertext is versioned (`v1`) AES-256-GCM. Boot applies SQL migrations and secret conversion in one transaction under an advisory lock, verifying readback with the current key before commit. A failure rolls back schema and data together.

Conversion covers provider tables, GitHub/user secrets, transcription keys, service environment variables, and webhook secrets. Legacy webhook plaintext is cleared only after verified encryption. Later boots rewrite nothing if the key is unchanged.

- Keeping a strong key: leave `NIXRE_AI_SECRET` unchanged. Old SHA-256 ciphertext and early audit-branch unversioned HKDF ciphertext are converted automatically.
- Rotating the key: set a new strong `NIXRE_AI_SECRET` and temporarily set `NIXRE_AI_SECRET_LEGACY` to the exact previous encryption material. If the old application fell back to its internal token, use that OLD token, not its replacement.
- Rotating the salt: also set `NIXRE_SECRET_SALT_LEGACY` to the previous salt while `NIXRE_SECRET_SALT` holds the new one.
- Recovering published defaults: name the old default as `NIXRE_AI_SECRET_LEGACY` and temporarily set `ALLOW_LEGACY_DEFAULT_SECRET_RECOVERY=1`. This only allows decrypting old data, not weak keys for new encryption/auth. Keep ingress disabled and rotate affected upstream credentials too.

Compose maps `NIXRE_AI_SECRET_LEGACY` to backend `AI_SECRET_LEGACY`. Outside Compose use `AI_SECRET`/`AI_SECRET_LEGACY` directly. Never print keys in support logs.
Look for `[migrate] verified ... secrets with current key; rewritten ...`. After success, remove the temporary legacy key/salt and recovery settings, recreate core, and confirm another boot reports zero rewrites. Keep old backup keys securely for backup recovery, not in the live app.

Migration 025 revokes sessions, so users must sign in again. Registration defaults to closed. Set `NIXRE_REGISTRATION_CLOSED=false` only if signups are intended.

## Containers and runtime compatibility

Compose keeps `<project>_default` for legacy connectivity. PostgreSQL moves to `<project>_nixre-data` and apps use `nixre-apps`. A custom `SANDBOX_NETWORK` must exist and include core through a local Compose override. Sandbox selection never falls back to an arbitrary bridge.

Reconciliation attaches managed legacy app containers to the apps network before removing obsolete attachments, keeping containers and volumes. Recreate all Compose services when upgrading networks, not only core. If you use the short-lived `nixre-app` override, inspect it and set `SANDBOX_NETWORK` to the actual retained network.

Outdated sandbox containers are replaced using their named workspace volume. Working files are not hard-reset. Containers with unexpected volume mappings are stopped and kept for manual recovery, not deleted. Shell tools need an authenticated conversation and Docker.

Migration 026 gives existing deployment services policy `1` and new services policy `2`. Policy 1 keeps legacy capabilities on recreation/rollback, so old entrypoints needing `CHOWN`, `SETUID`, or `SETGID` keep working. Policy 2 drops all capabilities and enables `no-new-privileges` by default. Old services do NOT automatically get policy 2.

After testing the image and any needed capability additions, an admin can PATCH a service with `{"security_policy_version":2}` and redeploy. Only admins may change this setting. Privileged/network overrides remain operator trust decisions. Runtime limits do not constrain Dockerfile build steps, and a shared daemon is not a full boundary against hostile tenants.

## Proxy identity and local AI

Configure both controlled proxy hops before exposing authentication endpoints:

- Core `TRUSTED_PROXY_CIDRS`: comma-separated Caddy peer IPs/CIDRs as seen by core. Never trust an entire shared app/sandbox subnet.
- Caddy `NIXRE_TRUSTED_EDGE_CIDRS`: space-separated controlled tunnel peers. Host-local cloudflared to host Caddy normally uses `127.0.0.1/32 ::1/128`. Containerized paths differ.
- Caddy overwrites XFF with its resolved client IP. Empty settings trust nobody, but then all users share the proxy's rate-limit bucket. Use stable controlled peers and recheck after recreation. The old `TRUST_PROXY` hop count is not used.

Verify with two clients through ingress: exhausting one's login budget must not block the other, and spoofed XFF must not create a new budget. Host Caddy needs equivalent settings in its ACTUAL configuration. Changing this repo does not reload it.

Private Ollama/STT origins need `NIXRE_AI_PRIVATE_ORIGINS`, a comma-separated exact-origin allowlist such as `http://ollama:11434`. No paths or wildcards. It applies to all AI/STT users, so never include administrative or metadata endpoints. Webhooks never get this exception. Public destinations are checked at connection time, including redirects, with DNS pinning.

## Domains and compromise recovery

Existing domains are grandfathered. Audit their claims and set `NIXRE_RESERVED_DOMAINS` before reopening traffic. Reservations apply to legacy and automatic routes too. New domains need TXT proof or explicit admin action. Cloudflare automation is admin-only, refuses conflicting records, and retries follow the same ownership policy.

This upgrade is not incident recovery. If published secrets were exposed or exploitation is suspected, review admins, organization memberships, passkeys, PATs, SSH keys, webhooks, DNS, images, and workspace contents. Revoke and re-enroll suspicious credentials through trusted recovery channels. Overwritten victim-owned passkeys can still authenticate, so revoking sessions is not enough. Migration 012 no longer grants organization ownership on namespace collisions for very old upgrades, but grants already applied need operator review.

## Verification and rollback

CI tests upgrades on disposable PostgreSQL. Locally, set `NIXRE_TEST_DATABASE_URL` ONLY to a disposable test database.

CI also runs the live container check. To run it locally with Docker and Node 22.19+:

```bash
mkdir -p /tmp/nixre-docker-check
node scripts/test-docker-upgrade.mjs --run --socket-gid 1000 --temp-root /tmp/nixre-docker-check
```

On Windows, use an existing temporary directory for `--temp-root`. Without `--run` the harness skips. It runs in a disposable privileged Docker-in-Docker daemon, never touches the live Compose stack, `.env`, or data, and publishes no test ports. It removes its daemon/network/volume when done and keeps diagnostics in the temporary directory. It needs image downloads and the Chromium build.

After upgrading, verify `/healthz`, login, private reads/diffs, Git clone/push, existing app domains, failed-release fallback, sandbox working files, and every secret store. Check the deploy proxy on port 3003 with the intended Host header.

Rollback needs a maintenance restore of the matching database, configuration, repositories/workspaces, and old image/code, with consistent database credentials. A Git checkout alone is not a rollback: old code cannot read new ciphertext. Do not reopen vulnerable old code publicly during recovery. Retry failed transactions after correcting configuration. Never delete migration markers or manually rerun migration 025.
