---
name: nixre
description: Operate and admin a self-hosted Nixre instance (a Git forge + AI assistant + deploy platform). Covers the deployment topology, how to authenticate (web login, personal access tokens, SSH keys, git clone/push over HTTPS and SSH), and how to manage everything — repos/spaces/pull requests/webhooks, deployments (services, env vars, custom domains, Cloudflare auto-DNS, TLS-risk gating), the AI assistant (providers/models), and server administration (users, registration lock, backups, logs, updates, troubleshooting). Use when working with, deploying, troubleshooting, configuring, or asking about nixre, nixre-core, or Nixre.
---

# Nixre ops & admin skill

A self-hosted **Git forge** that also runs an **AI engineering assistant** and a **Docker deploy platform** for repos and standalone space services. This skill is a general operations handbook for any Nixre install (the concepts and source tree at [architecture](references/architecture.md) apply broadly). Plug in your instance's own hostnames, IDs, and paths where noted.

## What Nixre is

- **Git forge**: spaces (orgs), repos, pull requests, signed webhooks, personal access tokens (PATs), SSH keys, passkeys, avatars — all owned by `nixre-core`, no external forge dependency.
- **AI assistant** ("Nixre Assistant"): an agentic copilot that reads files, searches code, runs shell in a sandboxed clone of the target repo, and chats in Ask/Plan/Agent/Debug modes.
- **Deployments**: hosted-repo Docker builds and standalone public HTTPS Git/image services, with guided llama.cpp and PostgreSQL 16/17 setup. Space Deployments offers a service list and Source / Configure / Review flow. Standalone services use recreate, stable internal aliases, and optional retained volumes; repo blue/green behavior persists. See [deployment limits and recovery](references/deployments.md).

## Identifying your instance's values

Replace the placeholders below with your own deployment's values (found in your tunnel config, `.env`, and Caddyfile). A typical single-host, Cloudflare-Tunnel-backed install looks like:

| Thing | Value (yours) |
|---|---|
| Web + API + SPA | `https://git.<your-domain>` (→ host Caddy `:3000`) |
| Git over SSH | `ssh://git@ssh.<your-domain>:3022/<space>/<repo>.git` |
| Source directory | `<nixre-dir>` (this repo) |
| Containers (long-running) | `nixre-core`, `nixre-db`, `nixre-ssh` — plus `nixre-web` (Caddy) **if your install uses the compose Caddy**; a host-Caddy install leaves it stopped |
| Build-only container | `nixre-agent-sandbox` — produces the sandbox image, then exits (`entrypoint: true`); it is never "running" |
| Host Caddy serves the SPA | `<nixre-dir>/ui/dist` on `:3000` |
| Deploy proxy (app traffic) | `127.0.0.1:3003` |
| Stack | host Caddy + Cloudflare Tunnel + nixre-core (Node/Postgres) |
| Tunnel | a `cloudflared` user service, config in `~/.cloudflared/`, ID in the tunnel |
| DB | `postgres:16` in container `nixre-db`; credentials come from `POSTGRES_*` in `.env`, **never** the old hard-coded `nixre`/`nixre` |
| Networks | `nixre-db` sits on the internal `nixre-data` network alone; only `nixre-core` spans both, so sandboxes/ssh/web cannot reach Postgres |

> **If your router has no port forwarding**, all external traffic enters via the Cloudflare Tunnel — do not try to reach nixre with A records / port forwards.

## The 10-second state check

```bash
cd <nixre-dir> && docker compose ps
curl -s http://127.0.0.1:3001/healthz        # nixre-core → {"ok":true}
systemctl --user status cloudflared-<name>    # tunnel up?
```

## Authentication & access (full detail: [references/authentication.md](references/authentication.md))

- **Web**: register/login on your instance. Sessions are server-side; passkeys create new sessions.
- **Git over HTTPS**: username is ignored, **password must be a PAT** (account passwords are never accepted for git). Mint one at **Settings → Access Tokens** (starts `nxp_`, shown once).
- **Git over SSH**: register a key at **Settings → SSH Keys**, then `git clone ssh://git@ssh.<your-domain>:3022/<space>/<repo>.git` (no expiry). The tunnel terminates SSH and forwards to the `nixre-ssh` container.
- **Direct-to-GitHub**: the assistant can clone/mirror `github.com` repos using your stored GitHub PAT. If the host has no shell GitHub credential, a terminal `git push` to GitHub fails — push from a machine with credentials.
- Registration is **closed by default** (`NIXRE_REGISTRATION_CLOSED=true` when set). The **first account ever** created becomes instance admin.

## Managing everything (point to [references/](references/))

- **Repos / spaces / PRs / webhooks** — [references/forge.md](references/forge.md)
- **Deployments** (services, env vars, domains, auto-DNS, TLS gate) — [references/deployments.md](references/deployments.md)
- **AI assistant** (providers, models, enabled/disabled, sandbox) — [references/ai-assistant.md](references/ai-assistant.md)
- **Admin & servers** (users, registration, backups, logs, updates) — [references/administration.md](references/administration.md)
- **Troubleshooting** (bug patterns, stale cache, TLS, tunnels) — [references/troubleshooting.md](references/troubleshooting.md)

## Helper scripts (run from `scripts/`)

```bash
./scripts/nixre-status.sh     # container/health/tunnel overview
./scripts/nixre-logs.sh [svc] # tail nixre-core (+ optional deploy proxy) logs
./scripts/nixre-backup.sh [dir] # pg_dump + tar the git repos
```

## Golden rules (things that bite people)

1. **Never `reset --hard` in the source directory.** `update-nixre.sh` fast-forwards and preserves local commits; a manual reset can destroy un-pushed work.
2. **The frontend may be served by host Caddy, not the `nixre-web` container.** Only rebuild/restart `nixre-core` for backend changes; rebuild `ui/dist` for UI changes, then `docker compose up -d --build nixre-core` to serve it.
3. **Deployments live in both space and repo views.** Standalone details: `/{space}?tab=deployments&service={id}`. Repo links remain `/{space}/{repo}?deploys=1&svc={id}`, with repo service sub-tabs using `?dtab=`. Canonical API: `/api/v1/spaces/{space}/deployments/services`; repo API routes persist.
4. **TLS is only safe for domains within Universal SSL coverage** (`<your-domain>` + one level). Multi-level names (a dot in a label) fail TLS — the UI gates these behind a confirmation. Prefer hyphenated labels.
5. **Verify DNS with `dig @1.1.1.1`**, not your resolver — some LAN resolvers cache NXDOMAIN aggressively.
6. **Cloudflare token** must have `Zone:Read` + `DNS:Edit` on every zone users attach domains from; otherwise auto-DNS fails.
7. **Secrets are required, not optional.** `NIXRE_INTERNAL_TOKEN`, `NIXRE_AI_SECRET` and `POSTGRES_PASSWORD` have no defaults — compose refuses to start and core refuses to boot on a known published value. Generate with `openssl rand -hex 32`.
8. **Registration is closed by default.** An unset `NIXRE_REGISTRATION_CLOSED` means closed. Set it to `false` in `.env`, or flip it live via `PUT /api/v1/admin/registration`.
9. **Custom domains must be verified before they route.** Attaching one parks it and issues a TXT challenge (`_nixre-verify.<domain>`); use the Verify action, or let an admin force it. Set `NIXRE_RESERVED_DOMAINS` to your own hostnames so a deployment can never claim them.
10. **Run tests from the right directory** (`cd ui && npx vitest run`, `cd backend && npm test`, or `npm test` at the repo root). Running `npx vitest run` from the root finds no jsdom config and fails every UI test with `document is not defined`.
11. **Standalone releases are recreate, not blue/green.** They briefly stop, use `nixre-svc-{id}`, and stay stopped after cutover failure until explicit recovery. Apply runtime reuses the current image; Rebuild/Deploy image fetches or pulls anew. Legacy repo blue/green fallback remains, without a stable alias.
12. **Internal does not mean space-isolated.** All apps share the approved apps network. Internal services disable edge routes/custom domains and have no public TCP proxy, but other apps can reach them. The forge database is isolated separately. Template volumes survive stop/delete, with no automatic backups or disk quotas; Postgres upgrades/credential rotation need explicit operator data/SQL work, not PATCH or image rollback.
13. **Host-model/GPU controls are not discovery tools.** An admin types an approved Linux GGUF host path for a read-only bind; there is no filesystem picker or upload. GPU requests need admin access and a working host NVIDIA runtime/Container Toolkit, not just a permitted UI flag. External Git is public HTTPS only, with host allowlisting, pinned public DNS, Git 2.37+, and Linux amd64/arm64 Docker builds.
14. **Publish backend and frontend together.** Rebuild/restart core for migration 028 and build/publish `ui/dist`. Source-only edits do not update the served UI. Do not claim live verification without checking the actual rollout.
