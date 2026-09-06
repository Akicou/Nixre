# Upgrading existing installations safely

Read this before upgrading from a version before migration 025, or rotating
encryption/database credentials. Do not discard old encryption material: old
database backups still need their original keys.

## Maintenance and backups

1. Prevent writes from web, SSH, assistant, and deployment clients. Stop core,
   SSH, and web using the old working configuration; leave PostgreSQL running
   for backup and credential rotation. Disable host-managed ingress too.
2. Take a PostgreSQL logical backup and backups of repositories, SSH host keys,
   sandbox workspace volumes, and private configuration. Keep these outside
   Git with restrictive permissions. Verify restoration to a disposable database.
3. Record the Compose project name and network overrides. Preserve that project
   name during upgrade. Inventory existing containers and named volumes. Do not
   use `down -v`, delete `data/pg`, or remove workspace volumes to fix failures.
4. Preserve local commits and uncommitted changes. The updater refuses dirty
   checkouts and uses `git merge --ff-only`; it never resets the working tree.

## Database credentials

`POSTGRES_PASSWORD` only initializes a NEW data directory. Changing it in `.env`
does not change an existing role's password. Older installations initialized with
user/database/password `nixre` need explicit rotation while clients are stopped.

For the standard old installation, open the database's local administration
session (use the actual existing role/database if customized):

```bash
docker exec -it nixre-db psql -U nixre -d nixre
```

Inside psql, use `\password nixre` to enter the new strong password without
putting it in shell history or an SQL command, then `\q`. Set the SAME value in
the private `.env` as `POSTGRES_PASSWORD`. Do not change `POSTGRES_USER` or
`POSTGRES_DB` unless those objects were separately migrated in PostgreSQL.

Compose now passes separate `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and
`PGDATABASE` fields; password punctuation cannot corrupt a generated URI.
Non-Compose installations may still supply `DATABASE_URL` with URI-encoded
credentials. A healthy `pg_isready` is not proof of correct application credentials.

## Encryption and sessions

New ciphertext is versioned (`v1`) and AES-256-GCM authenticated. Boot applies
SQL migrations and secret conversion under one transaction and advisory lock,
before serving requests. It verifies ciphertext readback with the current key
before committing. Failure rolls back schema and data changes together.

Both old/new provider tables, GitHub/user secrets, transcription keys, service
environment variables, and webhook secrets are covered. Legacy webhook plaintext
is cleared only after verified encryption. Subsequent boots verify secrets and
rewrite none when the key has not changed.

- **Keeping a strong key:** keep `NIXRE_AI_SECRET` unchanged. Old SHA-256
  ciphertext is converted automatically. Early audit-branch unversioned HKDF
  ciphertext is supported too.
- **Rotating the key:** set a new strong `NIXRE_AI_SECRET` and temporarily set
  `NIXRE_AI_SECRET_LEGACY` to the exact previous encryption material. If the old
  application fell back to its internal token, use that OLD token as the legacy
  material, not its replacement.
- **Rotating the salt:** also set `NIXRE_SECRET_SALT_LEGACY` to the previous salt
  while `NIXRE_SECRET_SALT` holds the new salt.
- **Recovering published defaults:** explicitly name the old default as
  `NIXRE_AI_SECRET_LEGACY` and temporarily set
  `ALLOW_LEGACY_DEFAULT_SECRET_RECOVERY=1`. This permits old-data decryption, not
  weak keys for new encryption/auth. Keep ingress disabled and rotate affected
  upstream credentials too.

Compose maps `NIXRE_AI_SECRET_LEGACY` to backend `AI_SECRET_LEGACY`. Outside
Compose use `AI_SECRET`/`AI_SECRET_LEGACY` directly. Never print keys in support
logs. There is no random-key fallback or silent empty-key substitution.

Look for `[migrate] verified ... secrets with current key; rewritten ...`.
After success, remove temporary legacy key/salt and recovery settings, recreate
core, and confirm another boot reports zero rewrites. Preserve old backup keys
securely for backup recovery, not in the live app.

Migration 025 deliberately revokes sessions, even though plaintext tokens could
technically be hashed. Users must sign in again. Registration defaults to closed;
set `NIXRE_REGISTRATION_CLOSED=false` only if signups are intended.

## Containers and runtime compatibility

Compose preserves `<project>_default` for legacy connectivity. PostgreSQL moves
to `<project>_nixre-data`; apps use `nixre-apps`. Actual network names, including
overrides, are passed into core. Sandbox selection checks Docker identity and
core membership; it never falls back to an arbitrary bridge. A custom
`SANDBOX_NETWORK` must exist and include core through a local Compose override.

Reconciliation attaches managed legacy app containers to the approved apps
network before removing obsolete attachments, preserving containers and volumes.
Explicit admin-approved network modes remain unchanged. Recreate all Compose
services when upgrading networks, not only core. Installations already using
the short-lived `nixre-app` override must inspect it and set `SANDBOX_NETWORK`
to the actual retained network.

Outdated sandbox containers are quarantined and replaced before execution using
their original named workspace volume. Working files are not hard-reset.
Unexpected volume mappings are stopped and retained for manual recovery rather
than deleted. Shell tools require an authenticated conversation and Docker;
there is no fallback to a core-local shell.

Migration 026 gives existing deployment services policy `1`; new services default
to `2`. Policy 1 preserves legacy capabilities on recreation/rollback; policy 2
drops all capabilities and enables `no-new-privileges` by default. This preserves
old entrypoints needing `CHOWN`, `SETUID`, or `SETGID`. Old services are NOT
claimed to have received policy 2 automatically.

An admin can PATCH a service with `{"security_policy_version":2}` and redeploy
after testing its image and required capability additions. Only admins may
change this setting. Ordinary edits and clearing runtime options preserve it.
Privileged/network overrides remain operator trust decisions. Runtime limits do
not constrain Dockerfile build steps; a shared daemon is not a full boundary
against hostile tenants.

## Proxy identity and local AI

Configure both controlled proxy hops before exposing authentication endpoints:

- Core `TRUSTED_PROXY_CIDRS`: comma-separated actual Caddy peer IPs/CIDRs as
  seen by core. Never trust an entire shared app/sandbox subnet.
- Caddy `NIXRE_TRUSTED_EDGE_CIDRS`: space-separated controlled tunnel peers.
  Host-local cloudflared to host Caddy normally uses `127.0.0.1/32 ::1/128`;
  containerized paths differ.
- Caddy overwrites XFF with its resolved client IP. Empty settings trust nobody,
  but users then share the proxy's rate-limit bucket. Use stable controlled
  peers and recheck after recreation. The old `TRUST_PROXY` hop count is not used.

Verify two clients through ingress: exhausting one's login budget must not block
the other, and spoofed XFF must not create a new budget. Host Caddy needs equivalent
settings in its ACTUAL configuration; changing this repo does not reload it.

Private Ollama/STT origins require `NIXRE_AI_PRIVATE_ORIGINS`, a comma-separated
exact-origin allowlist such as `http://ollama:11434`. These permissions apply to
all AI/STT users; never include administrative or metadata endpoints. No paths
or wildcards. Webhooks never receive this exception. Public destinations are
checked at connection time, including redirects, with DNS pinning.

## Domains and compromise recovery

Existing domains are grandfathered for availability. Audit their claims and set
`NIXRE_RESERVED_DOMAINS` before reopening traffic: reservations apply to legacy
and automatic routes too. New domains need TXT proof or explicit admin action.
Cloudflare automation is admin-only and refuses conflicting records; retries
follow the same ownership policy.

This upgrade is not automatic incident recovery. If published secrets were
exposed or exploitation is suspected, review admins, organization memberships,
passkeys, PATs, SSH keys, webhooks, DNS, images, and workspace contents. Revoke and
re-enroll suspicious credentials through trusted recovery channels. Previously
overwritten victim-owned passkeys can still authenticate; session revocation is
not enough. Migration 012 now avoids organization ownership grants on namespace
collisions for very old upgrades, but already-applied grants need operator review.

## Verification and rollback

CI uses disposable PostgreSQL for populated 007/024 upgrades, transaction rollback,
concurrent migrations, namespace collisions, and capability-policy defaults.
Locally set `NIXRE_TEST_DATABASE_URL` ONLY to a disposable test database.

The live container check is also run by CI. To run it locally with Docker and
Node 22.19+ available:

```bash
mkdir -p /tmp/nixre-docker-check
node scripts/test-docker-upgrade.mjs --run --socket-gid 1000 --temp-root /tmp/nixre-docker-check
```

On Windows, use an existing temporary directory for `--temp-root`. Without
`--run` the harness skips. It builds the real backend and sandbox images in a
disposable privileged Docker-in-Docker daemon. It never mounts the host Docker
socket into core or uses the live Compose stack, `.env`, or data. No test ports
are published. It verifies socket groups (including 0 and an existing GID),
startup, migrations, API authorization, network isolation, volume preservation,
capability compatibility, and failed-release fallback through proxy port 3003.
It removes its own daemon/network/volume on completion and retains diagnostics
in the temporary directory. Image downloads and the Chromium build are required.

After upgrade verify `/healthz`, login, private reads/diffs, Git clone/push,
existing app domains, failed-release fallback, sandbox working files, and every
secret store. Check the deploy proxy on port 3003 with the intended Host header.

Rollback requires a maintenance restore of matching database, configuration,
repositories/workspaces, and old image/code, with database credentials consistent.
A Git checkout alone is not rollback: old code cannot read new ciphertext. Do not
reopen vulnerable old code publicly during recovery. Retry failed transactions
after correcting configuration; never delete migration markers or manually rerun
migration 025.
