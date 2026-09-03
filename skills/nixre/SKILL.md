---
name: nixre
description: Operate and admin a self-hosted Nixre instance (a Git forge + AI assistant + deploy platform). Covers the full deployment topology, how to authenticate (web login, personal access tokens, SSH keys, git clone/push over HTTPS and SSH), and how to manage everything — repos/spaces/pull requests/webhooks, deployments (services, env vars, custom domains, Cloudflare auto-DNS, TLS-risk gating), the AI assistant (providers/models), and server administration (users, registration lock, backups, logs, updates, troubleshooting). Use when working with, deploying, troubleshooting, configuring, or asking about nixre, git.nixre.dev, nixre-core, or Nixre.
---

# Nixre ops & admin skill

A self-hosted **Git forge** that also runs an **AI engineering assistant** and a **Docker deploy platform** from your repos. This skill is written for the live instance at `git.nixre.dev` (operator-owned, registration closed) but the concepts and the source tree (see [architecture](references/architecture.md)) apply to any Nixre install.

## What Nixre is

- **Git forge**: spaces (orgs), repos, pull requests, signed webhooks, personal access tokens (PATs), SSH keys, passkeys, avatars — all owned by `nixre-core`, no external forge dependency.
- **AI assistant** ("Nixre Assistant"): an agentic copilot that reads files, searches code, runs shell in a sandboxed clone of the target repo, and chats in Ask/Plan/Agent/Debug modes.
- **Deployments**: turn any repo subdirectory into a Docker service (you bring the Dockerfile). Per-service env vars, limits, custom domains, blue/green releases, SSE logs.

## Quick facts (this instance)

| Thing | Value |
|---|---|
| Web + API + SPA | `https://git.nixre.dev` (→ host Caddy `:3000`) |
| Git over SSH | `ssh://git@ssh.nixre.dev:3022/<space>/<repo>.git` |
| Source tree on server | `/opt/nixre` (branch `feat/deployments`) |
| Containers (only 3 run) | `nixre-core`, `nixre-db`, `nixre-ssh` |
| Host Caddy serves the SPA | `/opt/nixre/ui/dist` on `:3000` |
| Deploy proxy (app traffic) | `127.0.0.1:3003` |
| Stack | Caddy (host) + Cloudflare Tunnel + nixre-core (Node/Postgres) |
| Tunnel | `cloudflared` user service `~/.cloudflared/config-nixre.yml`, ID `5f0d7f1f-fa8c-42cf-ac2e-7f602d0f6688` |
| DB | `postgres:16` in container `nixre-db`, user/db/pass all `nixre` |

> **No port forwarding** on this router — all external traffic enters via the Cloudflare Tunnel. Do not try to reach nixre with A records / port forwards.

## The 10-second state check

```bash
cd /opt/nixre && docker compose ps
curl -s http://127.0.0.1:3001/healthz        # nixre-core → {"ok":true}
systemctl --user status cloudflared-nixre     # tunnel up?
```

## Authentication & access (full detail: [references/authentication.md](references/authentication.md))

- **Web**: register/login on `https://git.nixre.dev`. Sessions are server-side; passkeys create new sessions.
- **Git over HTTPS**: username is ignored, **password must be a PAT** (account passwords are never accepted for git). Mint one at **Settings → Access Tokens** (starts `nxp_`, shown once).
- **Git over SSH**: register a key at **Settings → SSH Keys**, then `git clone ssh://git@ssh.nixre.dev:3022/<space>/<repo>.git` (no expiry). The tunnel terminates SSH and forwards to the `nixre-ssh` container.
- **Direct-to-GitHub**: the assistant can clone/mirror `github.com` repos using your stored GitHub PAT. On this server there is **no shell GitHub credential**, so `git push` to GitHub from a terminal fails — push from your machine.
- Registration is **closed** (`NIXRE_REGISTRATION_CLOSED=true`). The **first account ever** created becomes instance admin.

## Managing everything (point to [references/](references/))

- **Repos / spaces / PRs / webhooks** — [references/forge.md](references/forge.md)
- **Deployments** (services, env vars, domains, auto-DNS, TLS gate) — [references/deployments.md](references/deployments.md)
- **AI assistant** (providers, models, enabled/disabled, sandbox) — [references/ai-assistant.md](references/ai-assistant.md)
- **Admin & servers** (users, registration, backups, logs, updates) — [references/administration.md](references/administration.md)
- **Troubleshooting** (the bug patterns, stale cache, TLS, NaN, tunnels) — [references/troubleshooting.md](references/troubleshooting.md)

## Helper scripts (run from `scripts/`)

```bash
./scripts/nixre-status.sh     # container/health/tunnel overview
./scripts/nixre-logs.sh [svc] # tail nixre-core (+ optional deploy proxy) logs
./scripts/nixre-backup.sh [dir] # pg_dump + tar the git repos
```

## Golden rules (things that bite people)

1. **Never `reset --hard` in `/opt/nixre`.** `update-nixre.sh` fast-forwards and preserves local commits; a manual reset can destroy un-pushed work. The `feat/deployments` branch is ~23 commits ahead of origin and must be pushed from a machine with GitHub creds.
2. **The frontend is served by Caddy, not the `nixre-web` container.** Only rebuild/restart `nixre-core` for backend changes; rebuild `ui/dist` for UI changes, then `docker compose up -d --build nixre-core` to serve it.
3. **Deployments live inside the repo Code view**, not a separate page. Deep link `/{space}/{repo}?deploys=1`; sub-tabs use `?dtab=` (never `?tab=`).
4. **TLS is only safe for domains within Universal SSL coverage** (`nixre.dev` + one level). Multi-level names (a dot in a label) fail TLS — the UI gates these behind a confirmation. Prefer hyphenated labels.
5. **Verify DNS with `dig @1.1.1.1`**, not your resolver — your LAN resolver (192.168.0.254) caches NXDOMAIN aggressively.
6. **Cloudflare token** must have `Zone:Read` + `DNS:Edit` on every zone users attach domains from; otherwise auto-DNS fails.
