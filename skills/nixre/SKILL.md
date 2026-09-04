---
name: nixre
description: Operate and admin a self-hosted Nixre instance (a Git forge + AI assistant + deploy platform). Covers the deployment topology, how to authenticate (web login, personal access tokens, SSH keys, git clone/push over HTTPS and SSH), and how to manage everything — repos/spaces/pull requests/webhooks, deployments (services, env vars, custom domains, Cloudflare auto-DNS, TLS-risk gating), the AI assistant (providers/models), and server administration (users, registration lock, backups, logs, updates, troubleshooting). Use when working with, deploying, troubleshooting, configuring, or asking about nixre, nixre-core, or Nixre.
---

# Nixre ops & admin skill

A self-hosted **Git forge** that also runs an **AI engineering assistant** and a **Docker deploy platform** from your repos. This skill is a general operations handbook for any Nixre install (the concepts and source tree at [architecture](references/architecture.md) apply broadly). Plug in your instance's own hostnames, IDs, and paths where noted.

## What Nixre is

- **Git forge**: spaces (orgs), repos, pull requests, signed webhooks, personal access tokens (PATs), SSH keys, passkeys, avatars — all owned by `nixre-core`, no external forge dependency.
- **AI assistant** ("Nixre Assistant"): an agentic copilot that reads files, searches code, runs shell in a sandboxed clone of the target repo, and chats in Ask/Plan/Agent/Debug modes.
- **Deployments**: turn any repo subdirectory into a Docker service (you bring the Dockerfile). Per-service env vars, limits, custom domains, blue/green releases, SSE logs.

## Identifying your instance's values

Replace the placeholders below with your own deployment's values (found in your tunnel config, `.env`, and Caddyfile). A typical single-host, Cloudflare-Tunnel-backed install looks like:

| Thing | Value (yours) |
|---|---|
| Web + API + SPA | `https://git.<your-domain>` (→ host Caddy `:3000`) |
| Git over SSH | `ssh://git@ssh.<your-domain>:3022/<space>/<repo>.git` |
| Source directory | `<nixre-dir>` (this repo) |
| Containers (only 3 run) | `nixre-core`, `nixre-db`, `nixre-ssh` |
| Host Caddy serves the SPA | `<nixre-dir>/ui/dist` on `:3000` |
| Deploy proxy (app traffic) | `127.0.0.1:3003` |
| Stack | host Caddy + Cloudflare Tunnel + nixre-core (Node/Postgres) |
| Tunnel | a `cloudflared` user service, config in `~/.cloudflared/`, ID in the tunnel |
| DB | `postgres:16` in container `nixre-db`, user/db/pass all `nixre` |

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
3. **Deployments live inside the repo Code view**, not a separate page. Deep link `/{space}/{repo}?deploys=1`; sub-tabs use `?dtab=` (never `?tab=`).
4. **TLS is only safe for domains within Universal SSL coverage** (`<your-domain>` + one level). Multi-level names (a dot in a label) fail TLS — the UI gates these behind a confirmation. Prefer hyphenated labels.
5. **Verify DNS with `dig @1.1.1.1`**, not your resolver — some LAN resolvers cache NXDOMAIN aggressively.
6. **Cloudflare token** must have `Zone:Read` + `DNS:Edit` on every zone users attach domains from; otherwise auto-DNS fails.
