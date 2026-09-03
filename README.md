# Nixre

A self-hosted Git forge. Official site: [nixre.dev](https://nixre.dev). Live instance: [git.nixre.dev](https://git.nixre.dev) — a **personal instance**, not an open registration service: it hosts the owner's projects and accounts for invited friends only (registration is closed).

Nixre runs its own backend (nixre-core, Node + PostgreSQL), its own git storage (bare repositories on disk with Smart HTTP transport), and its own auth (argon2 + sessions + passkeys + PATs). It does not depend on Gitness or any other forge.

## Features

- **Minimalist UI**: Booton typography, JetBrains Mono for code, flat layout, dark/light theme.
- **Sovereign**: nixre-core owns auth, spaces, repos, git transport, pull requests, and account data. No external forge APIs.
- **Passkeys**: WebAuthn credentials stored server-side in your account. A passkey can open a new session.
- **Git Smart HTTP + SSH**: clone and push over HTTPS (`/git/<space>/<repo>.git`) with session/PAT basic auth, or over SSH (`ssh://git@host:3022/<space>/<repo>.git`) with your registered keys.
- **Pull requests**: create PRs between branches, view unified diffs per file, merge (`--no-ff`) or squash.
- **Signed webhooks**: subscribe `push` and `pull_request` events to external URLs. Deliveries are HMAC-SHA256 signed (`X-Nixre-Signature`) with retries and a delivery log.
- **Spaces**: multi-tenant workspaces with membership-based access control.
- **Personal access tokens and SSH keys**: mint PATs (returned once, stored hashed) and manage SSH public keys with fingerprints.
- **Plugin system**: bundled plugins stay inert until enabled. The Nixre Assistant is an AI engineering copilot. Plugin state is account-scoped and server-persisted.
- **Deployments**: ship any root-directory of a repo as a Docker service (you bring the Dockerfile — Nixre never invents the build). Push-to-branch auto-deploys with automatic fallback to the last healthy release, live build/deploy logs over SSE, Railway-style encrypted env vars, per-service CPU/RAM limits with live usage bars, HTTP request logs that preserve failures by status code by default, uptime/downtime charts, and custom domains routed through a central proxy port (`:3003`) with copy-paste DNS guidance for host Caddy/Nginx or Cloudflare Tunnel.

Plugins are gated twice: the operator enables a plugin for the instance, and each user toggles it on from **Plugins** (`/plugins`). Every plugin is disabled by default.

## Quick start

```bash
git clone https://github.com/Akicou/Nixre.git
cd Nixre
docker compose up -d
```

Open `http://localhost:3000` and register. The first account becomes the instance admin.

### The stack

| Service | What it is |
| --- | --- |
| `nixre-web` | Caddy: TLS entrypoint, reverse-proxies `/api/*` and `/git/*` to core, serves the static SPA |
| `nixre-core` | The backend: REST API, auth, git Smart HTTP (via `git http-backend`), PR merges, webhook delivery |
| `nixre-ssh` | SSH git transport: sshd with core-resolved keys (AuthorizedKeysCommand), each session locked to a per-key git-shell wrapper |
| `nixre-db` | PostgreSQL: users, sessions, tokens, spaces, repos, pull requests, webhooks, plugin prefs, chats, passkeys |

Git objects live as bare repositories on the `./data/repos` volume. Postgres holds metadata only, the same split Gitea and GitLab use.

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

### Webhooks

Create one via the API (`POST /api/v1/repos/<space>/<repo>/+/webhooks` with `{url, events}`). The response contains the signing secret, shown once. Deliveries post JSON with `X-Nixre-Event` and `X-Nixre-Signature: sha256=…` (HMAC-SHA256 of the raw body, keyed by the secret) and retry with backoff up to 5 attempts. Inspect history at `GET …/webhooks/<id>/deliveries`.

### Migrating from a legacy Gitness instance

```bash
node scripts/migrate-from-gitness.js http://old-gitness:3000 <admin-token>
```

Spaces and repositories migrate with full git history via `clone --mirror`. Users re-register with the same uid to re-own content. PR history and CI pipelines do not migrate.

## Self-hosting guide (custom subdomain + Sunrise Connect Box 3)

This section covers exposing Nixre on a custom subdomain (for example `git.yourdomain.com`) behind a Sunrise Connect Box 3 (or a standard ISP router) with automatic Let's Encrypt certificates using Caddy.

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

## Deployments (Docker apps from your repos)

Deploy any subdirectory of a hosted repo as a long-running service. **You bring the Dockerfile** — Nixre only detects and builds what you point it at, so a monorepo can ship many services from one repository.

### How it works

1. Open a repo → **Deployments** tab → *New service*.
2. Pick the **root directory**, hit **Detect Dockerfiles**, choose one, set the container port, CPU/RAM limits, and env vars.
3. Every push to the watched branch auto-deploys (`auto_deploy` per service), or deploy manually at any ref/sha.
4. Builds stream live over SSE; releases are blue/green — the new container must answer health probes before it receives traffic. **A failed build/release never touches the serving container**: traffic keeps flowing on the previous release while a red banner warns you about the failure. From history you can inspect logs, redeploy, roll back to an older healthy release, or delete records.
5. On restart (server reboot included) nixre-core reconciles state and recreates service containers from their stored images — `restart: unless-stopped` plus a boot sweep mean deployments come back up with Nixre itself.

Environment variables are editable either as individual variables or as a whole `.env` file: the Deployments → env tab has a **.env file** editor with client-side validation (valid names `[A-Za-z_][A-Za-z0-9_]*`, no duplicates, ≤64 vars, `KEY=value` with optional `export` prefix, quotes stripped, `#` comments and blank lines allowed but not stored) before anything reaches the API; the backend re-validates on `PUT …/env`. Saving is a full replace and takes effect on the next deploy. Deployments live as a tab of the repo view (`/{space}/{repo}?tab=deployments`) — there is no separate page.

### Routing public traffic

App containers are never port-published. They sit on core's docker network behind a central reverse proxy inside nixre-core on `DEPLOY_PROXY_PORT` (**3003** default, published to loopback in compose). Route your edge to it:

- **Cloudflare Tunnel (used by git.nixre.dev)** — the tunnel's catch-all ingress forwards every unmatched hostname to the deploy proxy, which routes by Host header. Attach a domain in the repo's **Deployments → Domains** tab and pick *Cloudflare Tunnel*: when `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_TUNNEL_ID` are configured, nixre-core **creates the proxied CNAME (`<domain>` → `<tunnel-id>.cfargotunnel.com`) automatically via the Cloudflare API** and removes it again when the domain is detached. The UI shows the DNS status per domain (auto-managed / failed with retry / manual guidance). The API token needs `Zone:Read` + `DNS:Edit` on every zone users may attach domains from — domains can live in any zone the token can see, there is no base-domain restriction.
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
