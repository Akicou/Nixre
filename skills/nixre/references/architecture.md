# Architecture — how a Nixre instance is deployed

The source tree (this repo) stocks a self-contained forge: UI (React/TS SPA), backend `nixre-core` (Node + Postgres), `nixre-ssh` (sshd), and git storage as bare repos on disk. A live install often runs a slimmed, host-managed variant when the router has no port forwarding.

## Containers (run via `docker compose`, in the source directory)

| Container | Runs | Host ports | Notes |
|---|---|---|---|
| `nixre-db` | Postgres 16 | (internal) | user/db/pass all `nixre`, volume `./data/pg` |
| `nixre-core` | the whole backend | `127.0.0.1:3001:3002`, `127.0.0.1:3003:3003` | api+git on 3002, deploy proxy on 3003 |
| `nixre-ssh` | sshd for git | `3022:3022` | resolves keys via core |
| `nixre-web` | Caddy container | — | optional; a host Caddy commonly replaces it |
| `nixre-agent-sandbox` | agent sandbox image | — | built once, idles; `entrypoint: true` |

## Request paths

```
Internet ──edge (host Caddy or Cloudflare Tunnel)──▶ git.<your-domain> ──▶ :3000 ──▶ core (127.0.0.1:3001:3002)
                                                 └─ ssh.<your-domain>  ──▶ nixre-ssh :3022
                                                 └─ <any app domain>   ──▶ deploy proxy :3003 (routes by Host)
```

- **Host Caddy** serves the SPA from `<nixre-dir>/ui/dist` and proxies `/api/*` and `/git/*` to `127.0.0.1:3001` (host) → core `:3002` (container).
- The **deploy proxy** inside nixre-core listens on port 3003 (published to loopback). App containers are **never port-published**; they sit on core's docker network and are reached only through this proxy.

## Cloudflare Tunnel (common public entry, no port forwarding)

- One tunnel, credentials file in `~/.cloudflared/` (e.g. `~/.cloudflared/<tunnel-id>.json`).
- Config `~/.cloudflared/config.yml` with ingress rules:
  - `git.<your-domain>` → `http://localhost:3000`
  - `ssh.<your-domain>` → `ssh://localhost:3022`
  - **catch-all** → `http://localhost:3003` (deployed-app custom domains; routes by Host header)
- Run as a **user** systemd service (enabled, with Linger) so no sudo is needed. Exec: `cloudflared --no-autoupdate --config ~/.cloudflared/config.yml tunnel run`.

## Environment knobs (`.env`, passed to nixre-core)

| Var | Meaning |
|---|---|
| `NIXRE_REGISTRATION_CLOSED` | `true` = `POST /api/v1/register` returns 403 |
| `CLOUDFLARE_API_TOKEN` | Token with `Zone:Read` + `DNS:Edit` (auto-DNS for domains) |
| `CLOUDFLARE_TUNNEL_ID` | The tunnel whose CNAME (`<id>.cfargotunnel.com`) auto-DNS points domains at |
| `NIXRE_INTERNAL_TOKEN` / `NIXRE_AI_SECRET` | internal auth / secret encryption |
| `DEPLOY_PROXY_PORT` | `3003` (0 disables) |

## Backend layout (`backend/src/`)

- `routes/` — auth.js, forge.js (spaces/repos/git/PRs), pullreq.js, account.js, ai.js (assistant + providers), deployments.js, webhooks.js, internal.js, sync.js.
- `lib/` — `auth.js` (argon2, sessions, PATs), `chatApply.js` / `agentJobs.js` / `agentLoop.js` (assistant run + SSE), `ai.js` (providers + streaming), `cloudflareDns.js` (auto-DNS), deployment drivers, `dotenv.ts` (UI-side env parser).
- `git/` — git CLI wrappers + Smart HTTP transport.
- `db/migrations/` — SQL migrations applied on boot. Relevant: `022_cf_domains.sql` (CF zone/record ids), `023_tls_risk.sql` (`deploy_domains.tls_risk`).

## Git object storage

Bare repos on `./data/repos` volume (mounted at `/data/repos` in core). Postgres holds metadata only — same split as Gitea/GitLab.
