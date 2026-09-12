# Nixre
A self-hosted Git forge. Official site: [nixre.dev](https://nixre.dev). Live instance: [git.nixre.dev](https://git.nixre.dev) — a **personal instance**, not an open registration service: it hosts the owner's projects and accounts for invited friends only (registration is closed).


Nixre runs its own backend (nixre-core, Node + PostgreSQL), its own git storage (bare repositories on disk with Smart HTTP transport), and its own auth (argon2 + sessions + passkeys + PATs). It does not depend on Gitness or any other forge.

## Features

- **Minimalist UI**: Booton typography, JetBrains Mono for code, flat layout, dark/light theme.
- **Sovereign**: nixre-core owns auth, spaces, repos, git transport, pull requests, and account data. Core forge features run independently; optional GitHub integration uses GitHub APIs.
- **Passkeys**: WebAuthn credentials stored server-side in your account. A passkey can open a new session.
- **Git Smart HTTP + SSH**: clone and push over HTTPS (`/git/<space>/<repo>.git`) with session/PAT basic auth, or over SSH (`ssh://git@host:3022/<space>/<repo>.git`) with your registered keys.
- **Pull requests**: create PRs between branches, view unified diffs per file, merge (`--no-ff`) or squash.
- **Signed webhooks**: subscribe `push` and `pull_request` events to external URLs. Deliveries are HMAC-SHA256 signed (`X-Nixre-Signature`) with retries and a delivery log.
- **Spaces**: multi-tenant workspaces with membership-based access control.
- **Personal access tokens and SSH keys**: mint PATs (returned once, stored hashed) and manage SSH public keys with fingerprints.
- **Plugin system**: bundled plugins stay inert until enabled. The Nixre Assistant is an AI engineering copilot. Plugin state is account-scoped and server-persisted.
- **Deployments**: run hosted-repo Docker builds or standalone space services from public HTTPS Git and container images, with guided llama.cpp and PostgreSQL 16/17 setup. The space Deployments tab lists services and offers a three-step New service flow; existing repo views and routes remain. Repo blue/green deployments retain push automation and fallback to the previous healthy release; standalone services use stop/start (`recreate`) releases and a stable internal hostname. Services include encrypted env vars, CPU/RAM limits, build/status events, logs, health metrics, and optional HTTP domains through the central proxy (`:3003`). Managed volumes are retained, not automatically backed up. See [deployment behavior and runtime options](docs/deployments-runtime.md).

Plugins are gated twice: the operator enables a plugin for the instance, and each user toggles it on from **Plugins** (`/plugins`). Every plugin is disabled by default.

## Quick start

**Existing installation?** Follow [the security upgrade guide](docs/security-upgrade.md)
before changing secrets or rebuilding. It covers legacy credential conversion,
PostgreSQL password rotation, container migration, proxy trust, and rollback.

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

Compose refuses to start without `.env`: `NIXRE_INTERNAL_TOKEN`, `NIXRE_AI_SECRET`
and `POSTGRES_PASSWORD` are all required, and core additionally refuses to boot
on a known published default for the first two. That is deliberate —
`/api/v1/internal/*` is reachable through the `/api/*` route, so a default token
is a live credential rather than a convenience.

Open `http://localhost:3000` and register. The first account becomes the instance admin.

> Registration is **closed by default**. Set `NIXRE_REGISTRATION_CLOSED=false`
> before the first boot (or flip it later from the admin console) to allow signups.

### The stack

| Service | What it is |
| --- | --- |
| `nixre-agent-sandbox` | Build-only: produces the `nixre-agent-sandbox` image the assistant's `run_command` uses. Exits immediately (`entrypoint: true`), so it is not "running". |
| `nixre-web` | Caddy: HTTP entrypoint on port 3000 (TLS terminates upstream), reverse-proxies `/api/*` and `/git/*` to core, serves the static SPA |
| `nixre-core` | The backend: REST API, auth, git Smart HTTP (via `git http-backend`), PR merges, webhook delivery |
| `nixre-ssh` | SSH git transport: sshd with core-resolved keys (AuthorizedKeysCommand), each session locked to a per-key git-shell wrapper |
| `nixre-db` | PostgreSQL: users, sessions, tokens, spaces, repos, pull requests, webhooks, plugin prefs, chats, passkeys |

`nixre-tunnel` (cloudflared) is also defined but sits behind the `tunnels` profile — start it with `docker compose --profile tunnels up -d`.

Git objects live as bare repositories on the `./data/repos` volume. Postgres holds metadata only, the same split Gitea and GitLab use.

**Networks.** Postgres is isolated on the internal `nixre-data` network; only `nixre-core` can reach it. Deployed app containers run on `nixre-apps` (with core, which probes and proxies to them) and agent sandboxes on a non-database network — so neither can open a socket to Postgres. This matters because a deployment's Dockerfile is user-supplied code and creating one only requires write access to a space.

**Custom domains are gated on ownership.** Attaching a hostname parks it until TXT proof or admin approval/provisioning. Cloudflare automation requires an admin and refuses conflicting records. `NIXRE_RESERVED_DOMAINS` protects your own hostnames across custom, automatic, and grandfathered routes.

**Proxy identity.** Configure `TRUSTED_PROXY_CIDRS` on core and, for tunnels,
`NIXRE_TRUSTED_EDGE_CIDRS` on Caddy with controlled peer addresses. Otherwise
visitors share the proxy's rate-limit bucket. Never trust shared app subnets.
Private AI/STT origins need explicit `NIXRE_AI_PRIVATE_ORIGINS` approval.

**Runtime compatibility.** Existing deployments retain their capability policy
on recreation; new services use least-privilege defaults. Admins can explicitly
migrate old services after image testing. See [runtime options](docs/deployments-runtime.md).

### Cloning

Git over HTTPS uses HTTP Basic auth where the **password must be a token** — account passwords are never accepted for git transport. Clone URLs and credentials:

1. Create a token in the web UI: **Settings → Access Tokens** → name it → Generate. It starts with `nxp_` and is shown only once.
2. Clone. When git (or your credential manager) prompts: **username** = your Nixre username (any value works; it is ignored), **password** = the token.

```bash
git clone https://<host>/git/<space>/<repo>.git
# or embed it directly:
git clone https://<username>:<token>@<host>/git/<space>/<repo>.git
```

Your credential manager stores it after the first successful auth, so pulls/pushes won't prompt again. Tokens have a lifetime (default 30 days) — when it expires you get `Authentication failed` and simply mint a new one. If git keeps failing after you fixed credentials, remove the stale cached entry (Windows: Credential Manager → Windows Credentials → `git:https://<host>`; macOS: `git credential-osxkeychain erase`).

Alternatively, clone over SSH with a registered key — no prompts, no expiry:

```bash
# register a public key in Settings → SSH Keys first
git clone ssh://git@<host>:3022/<space>/<repo>.git
```

If the instance is exposed through a **Cloudflare Tunnel** (the `git.nixre.dev` setup — no port forwarding), port 3022 is not directly reachable. Install `cloudflared` on the client machine and add this to `~/.ssh/config`:

```sshconfig
Host git.nixre.dev
    ProxyCommand cloudflared access ssh --hostname ssh.nixre.dev
```

Then clone as usual: `git clone git@git.nixre.dev:<space>/<repo>.git`.

### Webhooks

Create one via the API (`POST /api/v1/repos/<space>/<repo>/+/webhooks` with `{url, events}`). The response contains the signing secret, shown once. Deliveries post JSON with `X-Nixre-Event` and `X-Nixre-Signature: sha256=…` (HMAC-SHA256 of the raw body, keyed by the secret) and retry with backoff up to 5 attempts. Inspect history at `GET …/webhooks/<id>/deliveries`.

### Migrating from a legacy Gitness instance

```bash
node scripts/migrate-from-gitness.js http://old-gitness:3000 <admin-token>
```

Spaces and repositories migrate with full git history via `clone --mirror`. Users re-register with the same uid to re-own content. PR history and CI pipelines do not migrate.

## Self-hosting guide

Two ways to expose an instance publicly. **Option A (Cloudflare Tunnel)** is what `git.nixre.dev` uses: no port forwarding and no public IP needed, TLS is handled by Cloudflare, and it works behind any NAT / CGNAT or a router with no forwarding support. **Option B** is the classic setup: A record + port forwarding + Caddy ACME.

### Option A: Cloudflare Tunnel (no port forwarding)

1. **Create the tunnel** (on the Nixre host):

   ```bash
   cloudflared tunnel login          # browser flow: authorise your Cloudflare account/zone
   cloudflared tunnel create nixre   # writes ~/.cloudflared/<tunnel-id>.json
   ```

2. **Ingress config** — `~/.cloudflared/config-nixre.yml`:

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

   `localhost:3000` is the Caddy entrypoint (SPA + `/api/*` and `/git/*` proxied to nixre-core); `localhost:3022` is nixre-ssh.

3. **DNS records.** Either let cloudflared create them:

   ```bash
   cloudflared tunnel route dns nixre git.nixre.dev
   cloudflared tunnel route dns nixre ssh.nixre.dev
   ```

   or add them manually in the Cloudflare dashboard (needed when the login token cannot edit the zone's DNS):

   | Type | Name | Target | Proxy |
   | --- | --- | --- | --- |
   | CNAME | `git` | `<tunnel-id>.cfargotunnel.com` | Proxied |
   | CNAME | `ssh` | `<tunnel-id>.cfargotunnel.com` | Proxied |

4. **Run as a service** — user-level unit `~/.config/systemd/user/cloudflared-nixre.service` (enable linger with `sudo loginctl enable-linger $USER` so it survives logout and starts at boot):

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

5. **SSH clients through the tunnel.** Each client needs `cloudflared` plus this in `~/.ssh/config` (see [Cloning](#cloning)):

   ```sshconfig
   Host git.nixre.dev
       ProxyCommand cloudflared access ssh --hostname ssh.nixre.dev
   ```

6. **Cloudflare SSL/TLS mode:** **Full** is enough — the tunnel authenticates the origin with its credentials, no origin certificate required.

Note: after adding the proxied records, stale local/resolver caches can keep returning NXDOMAIN for a few minutes (TTL is 300s); `ipconfig /flushdns` (Windows) or a browser restart clears it.

### Option B: Direct exposure (port forwarding + Sunrise Connect Box 3)

This section covers exposing Nixre on a custom subdomain (for example `git.yourdomain.com`) behind a Sunrise Connect Box 3 (or a standard ISP router) with automatic Let's Encrypt certificates using Caddy. Skip this if you use Option A.

### 1. DNS configuration

At your domain registrar (Namecheap, Cloudflare, GoDaddy, Porkbun), add an A record:

- **Type:** `A`
- **Name / Host:** `git` (for `git.yourdomain.com`)
- **Value:** your public IPv4 address (find it with `curl ifconfig.me`)
- **TTL:** `Automatic` or `300s`

### 2. Sunrise Connect Box 3 port forwarding

1. Open `http://192.168.1.1` (the Sunrise Connect Box 3 admin portal).
2. Log in with the settings password on the sticker under your modem.
3. In the left sidebar, go to **Advanced settings** → **Security** → **Port forwarding**.
4. Click **Add rule** and configure two rules for your server's local IP (for example `192.168.1.114`):

#### Rule 1: HTTP / ACME SSL validation
- **Local IP:** `192.168.1.114` · **Ports:** `80` → `80` · **Protocol:** TCP · **Enabled:** On

#### Rule 2: HTTPS / secure web and git traffic
- **Local IP:** `192.168.1.114` · **Ports:** `443` → `443` · **Protocol:** TCP · **Enabled:** On

5. Click **Apply changes**.

> **Sunrise DS-Lite note:** if the "Port forwarding" option is missing, your connection is in IPv6 DS-Lite mode. Call Sunrise Support and ask for a public IPv4 Dual-Stack profile. It is free and takes about 10 minutes.

### 3. Caddy reverse proxy configuration

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

Restart Caddy (`sudo systemctl restart caddy`). It completes the ACME HTTP-01 challenge through the Sunrise box and serves a trusted certificate automatically.

## Deployments (repos and standalone services)

Deploy a hosted-repo subdirectory, a public external Git source, or a container
image as a long-running service. **You bring the Dockerfile** for Git builds;
Nixre does not invent the build. Standalone services belong to a space without
creating a forge repository.

### Create a standalone service

Open a space's **Deployments** tab, then **New service**. The searchable list
includes repo services and standalone services, with recent activity. Standalone
details open in the space; repo entries still open their repo deployment view.

1. **Source:** choose External Git, Container image, llama.cpp, or PostgreSQL.
   External Git takes a public HTTPS URL and a branch/full ref; the pull-request
   option produces `refs/pull/123/head`. For tags use `refs/tags/v1.2.3`, not a
   short tag name. Image sources take an image tag or digest.
2. **Configure:** set a name, CPU/RAM limits, and the relevant source/runtime
   fields. For Git, explicitly choose the build root, Dockerfile relative to
   that root, and optional multi-stage build target. Generic Git/image services
   offer a port, health check, command, env vars, and optional managed volume.
   Internal networking is the default; opt into HTTP routing deliberately.
3. **Review:** inspect the source, runtime, and mounts, then **Create and deploy**.
   Creation stores configuration first; a separate deployment request resolves
   Git/pulls an image. The resolved Git commit appears after the build, not in
   the review. If the deployment request fails after creation, open the existing
   service or retry its deployment instead of creating a duplicate.

**External Git requirements.** `github.com` is allowed by default;
`NIXRE_DEPLOY_GIT_HOSTS` adds exact public DNS hostnames. HTTPS port 443 only:
no credential URLs, redirects, SSH, private-repo auth, submodules, or LFS fetches.
DNS must be public and is pinned for the fetch. Core needs Git 2.37+ (installed
from the maintained distribution package in the core image); external builds
require a Linux amd64/arm64 Docker daemon. Source acquisition uses at most two
leases per core process, a 120-second acquisition/archive deadline, and 1 GiB
temporary-file/archive limits. Temporary-file usage is polled, not a disk quota.
There are no automatic external Git or image updates.

**llama.cpp.** The preset is an editable Git build, initially using the upstream
CPU Dockerfile and `server` target. An instance admin must **type an existing
absolute Linux host GGUF path** under `NIXRE_DEPLOY_BIND_ALLOWLIST`; the file is
mounted read-only at `/models/model.gguf`. There is no filesystem picker, upload,
or automatic model/hardware detection. NVIDIA mode requests
`runtime_options.host_config.gpus: "all"`, requires instance-admin permission
and a working host NVIDIA runtime/Container Toolkit, and suggests the CUDA
Dockerfile. Review paths, entrypoint, memory, and context for the selected ref
and model. CPU mode also needs permission for the host mount.

**PostgreSQL 16/17.** Select a major (17 by default), database, and user. The server
generates and encrypts the initialization password; authorized writers can reveal
or copy the connection URI after creation. The template is internal on 5432,
with Docker `pg_isready` health and volume `nixre-service-{id}-data` at
`/var/lib/postgresql/data`. Stop/delete retain that volume, but deletion removes
service metadata and stored credentials. There are no automatic backups or disk
quotas. The image/major, initialization variables, port, runtime, and storage are
locked: upgrades need a new service and explicit data migration/restore, not
PATCH. SQL credential rotation is separate. Image rollback is not database
rollback; template/managed-volume rollback and historical redeploy are disabled.

### Apply, rebuild, and recover

Standalone **Settings / Apply runtime** reuses the current healthy stored image
with current runtime settings and env. Save settings first. **Rebuild and deploy**
for Git fetches/builds current source; **Deploy image** pulls the configured image
and pins the resolved image ID to a Nixre-owned release tag. Apply and restart
recovery do not refresh an upstream image tag or Git ref.

All standalone releases use **recreate**: the old container stops before its
replacement starts, with downtime and a stable apps-network alias
`nixre-svc-{id}`. Builds/pulls that fail before cutover leave the previous release
alone. Once cutover starts, a failure or interruption leaves the service stopped
for explicit recovery, including after a core restart. Inspect logs and retained
data before requesting a new deploy; Start cannot resurrect a release whose safe
current pointer was cleared. Retaining data does not make it safe to revert an image.

**API:** `/api/v1/spaces/{space}/deployments/services` is the canonical service
base, with `/{id}` config/lifecycle, `/{id}/deploy`, `/{id}/deployments`, env,
events, logs, stats, uptime, and domain suffixes. POST creates config only; the
wizard then POSTs `/{id}/deploy`. Standalone access requires space membership
or instance-admin access even in public spaces. The existing repo-scoped API
continues to work. See [the API and runtime reference](docs/deployments-runtime.md)
for fields, permissions, health checks, mount policy, and recovery limits.

### Hosted-repo deployments

Open a repo's always-visible **Deployments** section and choose **New service**.
Pick the root, use **Detect Dockerfiles**, and set branch, port, limits, and env.
A repo can host multiple services; **Duplicate...** copies config and secrets
into the repo wizard. Push-to-branch automation remains repo-only. Existing
blue/green services keep the previous healthy release serving if a candidate
fails, and switch proxy traffic only after health checks pass. They do not expose
the standalone stable alias. Do not assume this fallback for recreate services.

Deployments are **visible immediately in the repo's Code view**, beside an expandable file tree on desktop. The **Layout** selector remembers each user's choice: **Split view** (default, file/README preview below), **Three columns** (side by side, with workspace scrolling on small screens), **Preview left**, or **Stacked**. See [repository workspace layouts](docs/repository-layouts.md). Existing `?deploys=1` and `?tab=deployments` links remain supported.

Repo env editors retain row editing and **Paste .env** / **.env file** modes.
Standalone creation accepts `.env` text; its Environment view reveals individual
keys and saves variable upserts without replaying masked secrets. API PATCH env
updates are partial merges; PUT env is full replacement except for protected
Postgres initialization values. Values are encrypted at rest and take effect on
the next container launch. Apply runtime uses the current image without a rebuild.

### Publish the feature

Rebuild/restart core with `docker compose up -d --build nixre-core` so migration
`028_standalone_deployments.sql` applies on boot. Build with `npm run build` from
`ui/` and publish the resulting `ui/dist` through the existing Caddy setup;
source changes alone do not update the served UI or `/llms.txt`. Follow the
[security upgrade guide](docs/security-upgrade.md) for an existing installation,
then check `/healthz` and test the desired service flow. These instructions do
not assert that the feature has been verified on a live instance.

### Routing public traffic

App containers are not port-published. They use the approved **shared apps
network**, not per-space isolation. `exposure: "internal"` disables automatic
addresses, custom-domain routing, and all other edge routes; there is no public
TCP proxy. Other deployed apps can still reach internal services, so use app/DB
authentication. The forge database is isolated on its separate data network;
template databases are app services on the shared network.

For `exposure: "http"`, a central reverse proxy inside nixre-core listens on
`DEPLOY_PROXY_PORT` (**3003** default, published to loopback in compose). Custom
domains require TXT ownership proof or admin approval; Cloudflare provisioning
is admin-only and refuses conflicting DNS records. Standalone domain controls
are in Settings; repo services retain their Domains tab. Route your edge to it:

- **Cloudflare Tunnel (used by git.nixre.dev)**: route intended app hostnames to
  the deploy proxy, which selects services by Host header. An admin attaching a
  tunnel domain with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_TUNNEL_ID` configured
  can provision its proxied CNAME to `<tunnel-id>.cfargotunnel.com`. Conflicting
  records are not overwritten. Other users need TXT proof and manual DNS setup.
  The UI reports auto-managed, failed/retry, or manual DNS status. The token
  needs `Zone:Read` and `DNS:Edit` for each relevant zone; reserved hostnames and
  the automatic `DEPLOY_BASE_DOMAIN` namespace cannot be claimed as custom domains.
- **Host Caddy / Nginx** — add a DNS A record `app.example.com → <server-ip>`, then a host block like
  ```
  app.example.com {
      reverse_proxy 127.0.0.1:3003
  }
  ```
  (TLS terminates at your host Caddy with automatic Let's Encrypt.) The UI generates the exact DNS table and snippet per domain.

The compose file also ships an optional token-based `nixre-tunnel` service (`--profile tunnels`) as an alternative to a host-level cloudflared — not needed when the operator already runs cloudflared directly.

### Observability defaults

- **HTTP logs**: method/path/status/duration per request. Failures ≥ `preserve_status_min` (default **400**) are kept 7 days by default; other responses 24 hours — all tunable per service.
- **Resources**: hard caps via container `NanoCpus`/`Memory`; live CPU % of limit and working-set memory bars sample `docker stats` every ~10s.
- **Uptime**: an internal prober hits each running service every ~30s and charts green/red buckets (24h/7d/30d views). The dashboard shows the most active deployments across all visible spaces with fleet uptime lanes.

### Configuration knobs

| Env | Default | Purpose |
|---|---|---|
| `DEPLOY_PROXY_PORT` | `3003` | Central app-traffic listener (set `0` to disable) |
| `DEPLOY_PROXY_BIND` | `127.0.0.1` | Compose publish binding for the proxy port |
| `DEPLOY_BASE_DOMAIN` | — | Enables `<name>` / `svc-<id>` automatic routing |
| `DEPLOY_HEALTH_TIMEOUT_MS` | `30000` | Max wait for a new release to answer |
| `DEPLOY_PROBE_MS` / `DEPLOY_METRICS_MS` / `DEPLOY_SWEEP_MS` | `30s` / `10s` / `60s` | Uptime probe, stats sampling, reconcile sweeps |

## Plugins

Plugins ship inside the repo but stay dormant until the two-layer gate opens.

### Activation layers

| Layer | Who | Where it lives |
| --- | --- | --- |
| **Server gate** | operator | which bundled plugins the instance serves |
| **User toggle** | any logged-in user | `/plugins` (off by default) |

A plugin is only live when both allow it. Activation state, plugin configs, assistant profiles, chat sessions, and the passkey vault are stored server-side in Postgres via nixre-core's account API, so everything follows the account across browsers and devices. A one-time migration uploaded any `localStorage`-era data on first login after the switch.

### Bundled plugins

| Plugin | What it does | Configuration |
| --- | --- | --- |
| **Nixre Assistant** | AI copilot for agentic engineering work. Add multiple providers (DeepSeek, OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint). Each is validated against the live provider and its model list is fetched automatically; you pick which models are enabled for chat and which provider is active. API keys are stored encrypted server-side and never sent to the browser. Streaming chat in four modes (Ask, Plan, Agent, Debug) with configurable reasoning levels and interleaved thinking, available on the dashboard and per repo. The workspace selector supports Nixre-hosted repos, github.com repositories (via the user's stored personal access token, cloned/mirrored automatically with direct-to-GitHub pushes) and an Unrestricted free-form sandbox mode. The agent can read files, search code, show images, run shell commands in a clone of the target repo, and search the web, each gated by a per-repo access profile. A validated provider is required; there is no offline fallback. | per-repo profile (`/plugins` + repo **Settings**) |

Everything else a forge needs is a first-class feature, not a plugin: webhooks (signed, with retries and a delivery log), spaces and members, pull requests, and SSH keys / PATs all live in nixre-core directly.

### Adding a plugin

1. Describe it in `ui/src/lib/plugins.ts` (id, name, icon, category, tools, `providerFields`/`accessFields`, and whether it is repo-scoped).
2. It appears on `/plugins` once the operator flips the server gate on.
3. Render its surface with `PluginConfigForm` (generic key/value) or `AssistantProfileForm` (provider + per-repo access).

A plugin is only listed in the registry when it ships a real backend path: its UI writes to nixre-core and the server enforces it. There are no prefs-only stubs.

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

### API surface (all first-party)

`/api/v1`: `login` `register` `logout` `user` `webauthn/login` `admin/users` `user/publickeys` `user/tokens` `user/memberships` `spaces` `repos` (+ `content` `raw` `commits` `branches` `pullreq` sub-resources) `prefs` `conversations` `passkeys`, plus `/git/{space}/{repo}.git` Smart HTTP.

## License

MIT License © 2026 Nixre Contributors · [nixre.dev](https://nixre.dev)

### Agent task controls

The Assistant now includes a live checklist, per-file change review, checkpoints, verification, project memory, permission presets, local browser checks, specialist agents, explicit task recovery, and usage limits. See [Agent task controls](docs/agent-task-controls.md) for behavior and deployment requirements.

Administrators can use [safe instance updates](docs/instance-updates.md) to review a CI-verified revision and run staged builds, database backup and migration rehearsal, health verification, and UI publication. An independent progress page remains available during backend restarts. One-time host worker setup is required; uncertain database changes require explicit operator recovery.
