# Nixre

A self-hosted Git forge. Official site: [nixre.dev](https://nixre.dev). Live instance: [git.nixre.dev](https://git.nixre.dev). It is a **personal instance**, not an open registration service: it hosts the owner's projects and accounts for invited friends only (registration is closed).

Nixre has its own backend (nixre-core, Node + PostgreSQL), its own git storage (bare repositories on disk, Smart HTTP transport) and its own auth (argon2, sessions, passkeys, PATs). It does not depend on Gitness or any other forge.

## Features

- **UI**: Booton and JetBrains Mono fonts, flat layout, dark/light theme.
- **Passkeys**: WebAuthn credentials stored server-side in your account.
- **Git over HTTPS and SSH**: `/git/<space>/<repo>.git` with session/PAT basic auth, or `ssh://git@host:3022/<space>/<repo>.git` with registered keys.
- **Pull requests**: unified diffs per file, merge (`--no-ff`) or squash. Each PR shows the checks on its latest commit, and **Require passing checks before merging** blocks the merge until they are green.
- **Issues and security scan**: per-repo issues, plus a built-in scan every 3 hours that checks running deployments and nixre-core for known CVEs, asks your configured assistant what matters, and files issues with the fix or dispatches a rebuild workflow. See [docs/security-scan.md](docs/security-scan.md).
- **Actions (CI/CD)**: workflows in `.nixre/workflows/*.yml` (`.gitea/workflows` and `.github/workflows` also work) run on push, pull request, cron or a manual **Run workflow** button. Jobs run in throwaway containers with a real checkout and support `needs`, matrices, `if:`, job outputs, encrypted secrets, live logs, cancel/re-run, commit statuses and README badges. `uses: nixre/deploy@v1` releases a deploy service once tests pass. See [docs/actions.md](docs/actions.md).
- **Stars, downloads, file finder**: stars sort the public home page, branches download as ZIP or tar.gz, `t` in a repo opens a fuzzy file finder.
- **Signed webhooks**: `push` and `pull_request` events, HMAC-SHA256 signed (`X-Nixre-Signature`), with retries and a delivery log.
- **Spaces**: multi-tenant workspaces with membership-based access.
- **Public browsing**: public repos, orgs and profiles are readable and cloneable without an account. Private content is members-only.
- **PATs and SSH keys**: PATs are shown once and stored hashed.
- **Plugins**: off until enabled. Bundled: the Nixre Assistant, an AI engineering copilot.
- **Deployments**: run any root directory of a repo as a Docker service (you supply the Dockerfile). Auto-deploy on push, fallback to the last healthy release, live logs, encrypted env vars, CPU/RAM limits, uptime charts, custom domains via proxy port `:3003`.

## Quick start

**Existing installation?** Read [the security upgrade guide](docs/security-upgrade.md) before changing secrets or rebuilding. It covers legacy credential conversion, PostgreSQL password rotation, container migration, proxy trust and rollback.

```bash
git clone https://github.com/Akicou/Nixre.git
cd Nixre
cp .env.example .env
# Generate the two required secrets and paste them into .env:
#   openssl rand -hex 32     -> NIXRE_INTERNAL_TOKEN
#   openssl rand -hex 32     -> NIXRE_AI_SECRET
#   (also set POSTGRES_PASSWORD)
# Then, to let people sign up, set NIXRE_REGISTRATION_CLOSED=false
#   (it defaults to closed, so a fresh instance never opens by accident)

docker compose up -d
```

Compose refuses to start without `.env` values for `NIXRE_INTERNAL_TOKEN`, `NIXRE_AI_SECRET` and `POSTGRES_PASSWORD`. Core also refuses to boot on a published default for the first two, since `/api/v1/internal/*` is reachable through `/api/*`.

Open `http://localhost:3000` and register. The first account becomes the instance admin. Registration is closed by default: set `NIXRE_REGISTRATION_CLOSED=false` before the first boot (or flip it later in the admin console) to allow signups.

### The stack

| Service | What it is |
| --- | --- |
| `nixre-agent-sandbox` | Build-only. Produces the image the assistant's `run_command` uses, then exits immediately (`entrypoint: true`). |
| `nixre-web` | Caddy on port 3000 (TLS terminates upstream). Proxies `/api/*` and `/git/*` to core and serves the static SPA. |
| `nixre-core` | Backend: REST API, auth, git Smart HTTP (via `git http-backend`), PR merges, webhook delivery. |
| `nixre-ssh` | SSH git transport: sshd with core-resolved keys (AuthorizedKeysCommand), each session locked to a per-key git-shell wrapper. |
| `nixre-db` | PostgreSQL: users, sessions, tokens, spaces, repos, pull requests, webhooks, plugin prefs, chats, passkeys. |

`nixre-tunnel` (cloudflared) is also defined behind the `tunnels` profile: `docker compose --profile tunnels up -d`.

Git objects live as bare repositories on the `./data/repos` volume. Postgres holds metadata only.

**Networks.** Postgres is on the internal `nixre-data` network and only `nixre-core` reaches it. Deployed apps run on `nixre-apps` (shared with core, which probes and proxies to them) and agent sandboxes on a non-database network, so neither can open a socket to Postgres. A deployment's Dockerfile is user-supplied code, so this isolation is required.

**Custom domains need proof of ownership.** A new hostname is parked until TXT proof or admin approval. Cloudflare automation requires an admin and refuses conflicting records. `NIXRE_RESERVED_DOMAINS` protects your own hostnames across custom, automatic and grandfathered routes.

**Proxy identity.** Set `TRUSTED_PROXY_CIDRS` on core and, for tunnels, `NIXRE_TRUSTED_EDGE_CIDRS` on Caddy with controlled peer addresses. Otherwise all visitors share the proxy's rate-limit bucket. Never trust shared app subnets. Private AI/STT origins need explicit approval via `NIXRE_AI_PRIVATE_ORIGINS`.

**Runtime compatibility.** Existing deployments keep their capability policy on recreation, and new services get least-privilege defaults. Admins can migrate old services after image testing. See [runtime options](docs/deployments-runtime.md).

### Cloning

Git over HTTPS uses HTTP Basic auth, and the password must be a token. Account passwords are never accepted for git transport.

1. Create a token under **Settings → Access Tokens**. It starts with `nxp_` and is shown once.
2. Clone. When prompted, use your Nixre username (any value works, it is ignored) and the token as password.

```bash
git clone https://<host>/git/<space>/<repo>.git
# or embed it directly:
git clone https://<username>:<token>@<host>/git/<space>/<repo>.git
```

Tokens expire (default 30 days); git then reports `Authentication failed` and you mint a new one. If git keeps failing after fixing credentials, remove the stale cached entry (Windows: Credential Manager → Windows Credentials → `git:https://<host>`; macOS: `git credential-osxkeychain erase`).

SSH with a registered key has no prompts and no expiry:

```bash
# register a public key in Settings → SSH Keys first
git clone ssh://git@<host>:3022/<space>/<repo>.git
```

If the instance is behind a **Cloudflare Tunnel** (the `git.nixre.dev` setup), port 3022 is not reachable directly. Install `cloudflared` on the client and add this to `~/.ssh/config`:

```sshconfig
Host git.nixre.dev
    ProxyCommand cloudflared access ssh --hostname ssh.nixre.dev
```

Then clone as usual: `git clone git@git.nixre.dev:<space>/<repo>.git`.

### Webhooks

Create one with `POST /api/v1/repos/<space>/<repo>/+/webhooks` and `{url, events}`. The response contains the signing secret, shown once. Deliveries are JSON with `X-Nixre-Event` and `X-Nixre-Signature: sha256=…` (HMAC-SHA256 of the raw body, keyed by the secret), retried with backoff up to 5 attempts. History is at `GET …/webhooks/<id>/deliveries`.

### Migrating from a legacy Gitness instance

```bash
node scripts/migrate-from-gitness.js http://old-gitness:3000 <admin-token>
```

Spaces and repositories migrate with full git history via `clone --mirror`. Users re-register with the same uid to re-own content. PR history and CI pipelines do not migrate.

## Self-hosting guide

There are two ways to expose an instance. **Option A (Cloudflare Tunnel)** is what `git.nixre.dev` uses: no port forwarding or public IP, TLS handled by Cloudflare, works behind NAT/CGNAT. **Option B** is an A record, port forwarding and Caddy ACME.

### Option A: Cloudflare Tunnel (no port forwarding)

1. **Create the tunnel** on the Nixre host:

   ```bash
   cloudflared tunnel login          # browser flow: authorise your Cloudflare account/zone
   cloudflared tunnel create nixre   # writes ~/.cloudflared/<tunnel-id>.json
   ```

2. **Ingress config** in `~/.cloudflared/config-nixre.yml`:

   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json

   ingress:
     - hostname: git.nixre.dev
       service: http://localhost:3000
     - hostname: ssh.nixre.dev
       service: ssh://localhost:3022
     - service: http_status:404
   ```

   `localhost:3000` is the Caddy entrypoint (SPA, plus `/api/*` and `/git/*` proxied to nixre-core). `localhost:3022` is nixre-ssh.

3. **DNS records.** Let cloudflared create them:

   ```bash
   cloudflared tunnel route dns nixre git.nixre.dev
   cloudflared tunnel route dns nixre ssh.nixre.dev
   ```

   or add them in the Cloudflare dashboard (needed when the login token cannot edit the zone's DNS):

   | Type | Name | Target | Proxy |
   | --- | --- | --- | --- |
   | CNAME | `git` | `<tunnel-id>.cfargotunnel.com` | Proxied |
   | CNAME | `ssh` | `<tunnel-id>.cfargotunnel.com` | Proxied |

4. **Run as a service** with a user-level unit at `~/.config/systemd/user/cloudflared-nixre.service`. Enable linger (`sudo loginctl enable-linger $USER`) so it survives logout and starts at boot:

   ```ini
   [Unit]
   Description=cloudflared tunnel for nixre.dev
   After=network-online.target
   Wants=network-online.target

   [Service]
   ExecStart=/usr/local/bin/cloudflared --no-autoupdate --config %h/.cloudflared/config-nixre.yml tunnel run
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=default.target
   ```

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now cloudflared-nixre
   ```

5. **SSH clients** need `cloudflared` plus this in `~/.ssh/config` (see [Cloning](#cloning)):

   ```sshconfig
   Host git.nixre.dev
       ProxyCommand cloudflared access ssh --hostname ssh.nixre.dev
   ```

6. **Cloudflare SSL/TLS mode**: **Full** is enough. The tunnel authenticates the origin, so no origin certificate is needed.

After adding the proxied records, stale resolver caches can return NXDOMAIN for a few minutes (TTL 300s). `ipconfig /flushdns` (Windows) or a browser restart clears it.

### Option B: Direct exposure (port forwarding + Sunrise Connect Box 3)

Exposes Nixre on a custom subdomain (for example `git.yourdomain.com`) behind a Sunrise Connect Box 3 or standard ISP router, with Let's Encrypt via Caddy.

#### 1. DNS configuration

At your registrar (Namecheap, Cloudflare, GoDaddy, Porkbun), add an A record:

- **Type:** `A`
- **Name / Host:** `git` (for `git.yourdomain.com`)
- **Value:** your public IPv4 address (find it with `curl ifconfig.me`)
- **TTL:** `Automatic` or `300s`

#### 2. Sunrise Connect Box 3 port forwarding

1. Open `http://192.168.1.1` and log in with the settings password on the modem's sticker.
2. Go to **Advanced settings** → **Security** → **Port forwarding**.
3. Add two TCP rules to your server's local IP (for example `192.168.1.114`): `80` → `80` (ACME validation) and `443` → `443` (web and git).
4. Click **Apply changes**.

> **DS-Lite:** if "Port forwarding" is missing, your connection is in IPv6 DS-Lite mode. Ask Sunrise Support for a public IPv4 Dual-Stack profile. It is free and takes about 10 minutes.

#### 3. Caddy reverse proxy

```caddyfile
git.yourdomain.com {
    handle /api/* {
        reverse_proxy 127.0.0.1:3002
    }
    handle /git/* {
        reverse_proxy 127.0.0.1:3002
    }
    handle {
        root * /opt/nixre/ui/dist
        try_files {path} /index.html
        file_server
    }
}
```

Restart Caddy (`sudo systemctl restart caddy`). It completes the ACME HTTP-01 challenge itself.

## Deployments (Docker apps from your repos)

Deploy any subdirectory of a hosted repo as a long-running service. You supply the Dockerfile, so a monorepo can ship many services.

### How it works

0. **Organization board**: a space's **Deployments** tab lists its services as cards (status, domain, last deploy) with a live Activity feed.
1. In a repo's **Deployments** section choose *New service*. A repo can host several services (for example one Dockerfile with different env vars, ports or branches). **Duplicate…** copies a service's config and secrets into the wizard.
2. Pick the **root directory**, press **Detect Dockerfiles**, choose one, then set the container port, CPU/RAM limits and env vars.
3. Pushes to the watched branch auto-deploy (`auto_deploy` per service). Any ref/sha can also be deployed manually.
4. Builds stream over SSE. Releases are blue/green: the new container must pass health probes before it gets traffic. A failed build or release leaves the serving container alone and shows a red banner. History lets you inspect logs, redeploy, roll back or delete records.
5. After a restart or reboot, nixre-core recreates service containers from stored images (`restart: unless-stopped` plus a boot sweep).

Deployments show in the repo's Code view. A per-user **Layout** selector offers **Split view** (default), **Three columns**, **Preview left** and **Stacked**; see [repository workspace layouts](docs/repository-layouts.md). Old `?deploys=1` and `?tab=deployments` links still work.

Env vars can be edited singly or as a whole `.env` file, in the create wizard (**Paste .env**) and in each service's env tab (**.env file** editor). Validation: names match `[A-Za-z_][a-zA-Z0-9_]*`, no duplicates, at most 100 vars, `KEY=value` with optional `export` prefix, quotes stripped, `#` comments and blank lines allowed but not stored. The backend re-validates on `PUT …/env`. Saving replaces the full set and applies on the next deploy.

### Routing public traffic

App containers are never port-published. They sit on core's docker network behind a central reverse proxy inside nixre-core on `DEPLOY_PROXY_PORT` (default **3003**, published to loopback in compose). Route your edge to it:

- **Cloudflare Tunnel** (used by git.nixre.dev): the tunnel's catch-all ingress forwards every unmatched hostname to the deploy proxy, which routes by Host header. Attach a domain under **Deployments → Domains** and pick *Cloudflare Tunnel*. With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_TUNNEL_ID` set, nixre-core creates the proxied CNAME (`<domain>` → `<tunnel-id>.cfargotunnel.com`) through the Cloudflare API and removes it when the domain is detached. The UI shows DNS status per domain. The token needs `Zone:Read` + `DNS:Edit` on every zone users may attach domains from.
- **Host Caddy / Nginx**: add a DNS A record `app.example.com → <server-ip>`, then a host block like
  ```
  app.example.com {
      reverse_proxy 127.0.0.1:3003
  }
  ```
  TLS terminates at your host Caddy (automatic Let's Encrypt). The UI generates the exact DNS table and snippet per domain.

### Observability defaults

- **HTTP logs**: method, path, status and duration per request. Failures at or above `preserve_status_min` (default **400**) are kept 7 days, other responses 24 hours. All are tunable per service.
- **Resources**: hard caps via container `NanoCpus`/`Memory`. CPU % of limit and working-set memory bars sample `docker stats` about every 10s.
- **Uptime**: a prober hits each running service about every 30s and charts green/red buckets (24h/7d/30d).

### Configuration

| Env | Default | Purpose |
|---|---|---|
| `DEPLOY_PROXY_PORT` | `3003` | Central app-traffic listener (`0` disables) |
| `DEPLOY_PROXY_BIND` | `127.0.0.1` | Compose publish binding for the proxy port |
| `DEPLOY_BASE_DOMAIN` | — | Enables `<name>` / `svc-<id>` automatic routing |
| `DEPLOY_HEALTH_TIMEOUT_MS` | `30000` | Max wait for a new release to answer |
| `DEPLOY_PROBE_MS` / `DEPLOY_METRICS_MS` / `DEPLOY_SWEEP_MS` | `30s` / `10s` / `60s` | Uptime probe, stats sampling, reconcile sweeps |
| `TUNNEL_METRICS_URL` | — | cloudflared metrics endpoint; enables tunnel health sampling |
| `TUNNEL_PROBE_MS` | `30s` | Tunnel health sampling interval |

## Actions (CI/CD)

Put a workflow in `.nixre/workflows/ci.yml` and push:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest   # node:22-bookworm; any image works: `container: python:3.12`
    steps:
      - run: npm ci
      - run: npm test
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: nixre/deploy@v1
        with:
          service: web
```

Runs appear in the repo's **Actions** tab with live logs. The runner is built into `nixre-core` and uses the same Docker socket as deployments, so nothing else needs installing. Syntax, security model, limits and API: [docs/actions.md](docs/actions.md).

## Plugins

Plugins ship in the repo and are disabled by default. A plugin is live only when both gates allow it:

| Layer | Who | Where |
| --- | --- | --- |
| Server gate | operator | which bundled plugins the instance serves |
| User toggle | any logged-in user | `/plugins` |

Plugin state, configs, assistant profiles, chats and the passkey vault are stored in Postgres per account.

### Bundled plugins

| Plugin | What it does | Configuration |
| --- | --- | --- |
| **Nixre Assistant** | AI copilot. Providers: DeepSeek, OpenAI, Anthropic, Ollama or any OpenAI-compatible endpoint, validated live with models fetched automatically. API keys are stored encrypted server-side and never sent to the browser. Chat modes: Ask, Plan, Agent, Debug, on the dashboard and per repo. Workspaces: Nixre repos, github.com repos (via the user's stored PAT, pushes go directly to GitHub) and an Unrestricted sandbox. The agent can read files, search code, show images, run shell commands in a clone and search the web, each gated by a per-repo access profile. A validated provider is required. | per-repo profile (`/plugins` + repo **Settings**) |

### Adding a plugin

1. Describe it in `ui/src/lib/plugins.ts` (id, name, icon, category, tools, `providerFields`/`accessFields`, and whether it is repo-scoped).
2. It appears on `/plugins` once the operator enables the server gate.
3. Render its UI with `PluginConfigForm` (generic key/value) or `AssistantProfileForm` (provider + per-repo access).

### Agent task controls

Task checklist, change review, checkpoints, memory, permission presets and usage limits for the Assistant: [Agent task controls](docs/agent-task-controls.md).

## Instance updates

Admins can run staged updates of a CI-verified revision (backup, migration rehearsal, health checks, UI publication). It needs one-time host worker setup. See [safe instance updates](docs/instance-updates.md).

## Project architecture

```
Nixre architecture (no external forge)
 ├── ui/                            # React + TypeScript + Tailwind SPA
 │    ├── src/lib/api.ts            # REST client → nixre-core only
 │    ├── src/lib/syncApi.ts        # Account-state client (prefs, chats, passkeys)
 │    ├── src/lib/plugins.ts        # Plugin registry
 │    ├── src/lib/assistant*        # Assistant engine + profiles (server-backed)
 │    ├── src/components/           # PullRequestForm/Detail, ChatSurface, PluginToggle, ...
 │    ├── src/pages/                # Views (RepoView, Settings, Admin, Plugins, ...)
 │    └── dist/                     # Production build output (committed)
 ├── backend/                       # nixre-core, the entire backend
 │    ├── src/routes/               # auth, sync, forge (spaces/repos/git), pullreq, account
 │    ├── src/git/                  # git CLI wrappers + Smart HTTP transport
 │    ├── src/lib/auth.js           # argon2, sessions, PATs
 │    └── src/db/migrations/        # SQL migrations (applied on boot)
 ├── ssh/                            # nixre-ssh, SSH git transport
 │    ├── nixre-git-shell            # per-key ForcedCommand wrapper (ACL-checked)
 │    └── ssh-authorized-keys        # AuthorizedKeysCommand shim (core-resolved keys)
 ├── scripts/migrate-from-gitness.js  # one-time legacy migration
 ├── docker-compose.yml             # core + postgres + caddy
 └── Caddyfile                      # reverse proxy & static SPA handler
```

### Running tests

```bash
cd ui
npm install
npm test
```

### API surface

`/api/v1`: `login` `register` `logout` `user` `webauthn/login` `admin/users` `user/publickeys` `user/tokens` `user/memberships` `spaces` `repos` (+ `content` `raw` `commits` `branches` `pullreq` `actions` `statuses` `star` `archive` `files` sub-resources) `prefs` `conversations` `passkeys`, plus `/git/{space}/{repo}.git` Smart HTTP.

## License

MIT License © 2026 Nixre Contributors · [nixre.dev](https://nixre.dev)
