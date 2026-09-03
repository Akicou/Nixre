# Architecture — how this Nixre instance is deployed

The source tree (`/opt/nixre`) stocks a self-contained forge: UI (React/TS SPA), backend `nixre-core` (Node + Postgres), `nixre-ssh` (sshd), and git storage as bare repos on disk. But the **live instance runs a slimmed, host-managed variant** because the router has no port forwarding.

## Containers (run via `docker compose`, in `/opt/nixre`)

| Container | Runs | Host ports | Notes |
|---|---|---|---|
| `nixre-db` | Postgres 16 | (internal) | user/db/pass all `nixre`, volume `./data/pg` |
| `nixre-core` | the whole backend | `127.0.0.1:3001:3002`, `127.0.0.1:3003:3003` | api+git on 3002, deploy proxy on 3003 |
| `nixre-ssh` | sshd for git | `3022:3022` | resolves keys via core |
| `nixre-web` | Caddy container | — | **NOT running** — host Caddy replaces it |
| `nixre-agent-sandbox` | agent sandbox image | — | built once, idles; `entrypoint: true` |

## Request paths

```
Internet ──Cloudflare Tunnel──▶ git.nixre.dev ──▶ host Caddy :3000 ──▶ core (127.0.0.1:3001:3002)
                              └─ ssh.nixre.dev ──▶ nixre-ssh :3022
                              └─ <any app domain> ──▶ deploy proxy :3003 (routes by Host)
```

- **Host Caddy** (`/etc/caddy/Caddyfile`, `:3000` block) serves the SPA from `/opt/nixre/ui/dist` and proxies `/api/*` and `/git/*` to `127.0.0.1:3001` (host) → core `:3002` (container).
- It also has a **second block** bound to the old `git.nayhein.com` hostname — leave it; only the `:3000` block is used by the tunnel today.
- The **deploy proxy** inside nixre-core listens on port 3003 (published to loopback). App containers are **never port-published**; they sit on core's docker network and are reached only through this proxy.

## Cloudflare Tunnel (the only public entry)

- Tunnel ID `5f0d7f1f-fa8c-42cf-ac2e-7f602d0f6688`, creds file `~/.cloudflared/5f0d7f1f-...json`.
- Config `~/.cloudflared/config-nixre.yml`:
  - `git.nixre.dev` → `http://localhost:3000`
  - `ssh.nixre.dev` → `ssh://localhost:3022`
  - **catch-all** → `http://localhost:3003` (deployed-app custom domains; routes by Host header)
- Runs as a **user** systemd service `cloudflared-nixre` (enabled, with Linger) so no sudo needed. Exec: `cloudflared --no-autoupdate --config ... tunnel run`.

## Environment knobs (`/opt/nixre/.env`, passed to nixre-core)

| Var | Meaning |
|---|---|
| `NIXRE_REGISTRATION_CLOSED` | `true` = `POST /api/v1/register` returns 403 |
| `CLOUDFLARE_API_TOKEN` | Token with `Zone:Read` + `DNS:Edit` (auto-DNS for domains) |
| `CLOUDFLARE_TUNNEL_ID` | The tunnel whose CNAME (`<id>.cfargotunnel.com`) auto-DNS points domains at |
| `NIXRE_INTERNAL_TOKEN` / `NIXRE_AI_SECRET` | internal auth / secret encryption |
| `DEPLOY_PROXY_PORT` | `3003` (0 disables) |

## Backend layout (`backend/src/`)

- `routes/` — auth.js, forge.js (spaces/repos/git/PRs), pullreq.js, account.js, ai.js (assistant + providers), deployments.js, webhooks.js, internal.js, sync.js.
- `lib/` — `auth.js` (argon2, sessions, PATs), `chatApply.js` / `agentJobs.js` / `agentLoop.js` (assistant run + SSE), `ai.js` (providers + streaming), `cloudflareDns.js` (auto-DNS), deployments + deploy drivers, `dotenv.ts` (UI-side env parser).
- `git/` — git CLI wrappers + Smart HTTP transport.
- `db/migrations/` — SQL migrations applied on boot. Latest relevant: `022_cf_domains.sql` (CF zone/record ids), `023_tls_risk.sql` (`deploy_domains.tls_risk`).

## Git object storage

Bare repos on `./data/repos` volume (RH: `/data/repos`). Postgres holds metadata only — same split as Gitea/GitLab.
