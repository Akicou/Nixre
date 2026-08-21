# Nixre

> **Sovereign, minimalist, and ultra-fast code collaboration forge.**  
> Official site: **[nixre.dev](https://nixre.dev)** • Live Instance: **[git.nayhein.com](https://git.nayhein.com)**

Nixre is a modern open-source Git forge that is **100% sovereign end to end**: its own backend (**nixre-core**, Node + PostgreSQL), its own git storage (bare repositories on disk with Smart HTTP transport), its own auth (argon2 + sessions + passkeys + PATs). No Gitness, no external forge dependency, no vendor locks — one codebase, one database, one git engine, all owned by Nixre.

---

## ✨ Features

- **🎨 Minimalist Radicle-Inspired UI**: Booton typography, JetBrains Mono code rendering, flat layout (`decard`), dark/light theme.
- **🛡️ 100% Sovereign**: nixre-core owns auth, spaces, repos, git transport, pull requests, and account data. Zero external forge APIs.
- **🔑 Passkeys**: WebAuthn device credentials stored server-side in your account; a passkey can open a brand-new session.
- **⚡ Git Smart HTTP**: Clone/push over HTTPS (`/git/<space>/<repo>.git`) with session or PAT basic-auth. Real git, real history.
- **🔄 Pull Requests**: create PRs between branches, view unified diffs per changed file, merge (`--no-ff`) or squash with one click.
- **📁 Spaces & Organizations**: multi-tenant workspaces with membership-based access control.
- **🔐 Personal Access Tokens & SSH Keys**: mint PATs (returned once, stored hashed) and manage SSH public keys with fingerprints.
- **🧩 Plugin System**: bundled plugins that stay inert until enabled — AI engineering copilot (Nixre Assistant), security scanning, issues, code review, and more. All plugin state is account-scoped and server-persisted.

Plugins are activated behind a two-layer gate: (1) the operator enables a plugin for the instance, and (2) each user toggles it on from **Plugins** (`/plugins`). Every plugin is disabled by default.

---

## 🛠️ Quick Start

```bash
git clone https://github.com/Akicou/Nixre.git
cd Nixre
docker compose up -d
```

Open `http://localhost:3000` and register — **the first account becomes the instance admin**.

### The stack

| Service | What it is |
| --- | --- |
| `nixre-web` | Caddy: TLS entrypoint, reverse-proxies `/api/*` and `/git/*` to core, serves the static SPA |
| `nixre-core` | The entire backend: REST API, auth, git Smart HTTP (via `git http-backend`), PR merges |
| `nixre-db` | PostgreSQL: users, sessions, tokens, spaces, repos, pull requests, plugin prefs, chats, passkeys |

Git objects live as bare repositories on the `./data/repos` volume; Postgres holds metadata only (the same split Gitea/GitLab use).

### Cloning

```bash
git clone http://<host>/git/<space>/<repo>.git
# username: your uid   password: a session token or PAT (Settings → Tokens)
```

### Migrating from a legacy Gitness instance

```bash
node scripts/migrate-from-gitness.js http://old-gitness:3000 <admin-token>
```

Spaces and repositories (full git history via `clone --mirror`) migrate; users re-register with the same uid to re-own content. PR history and CI pipelines do not migrate.

---

## 🌐 Self-Hosting Guide (Custom Subdomain + Sunrise Connect Box 3)

This section documents how to expose Nixre on a custom subdomain (e.g. `git.yourdomain.com`) behind a **Sunrise Connect Box 3** (or standard ISP modem/router) with **automatic Let's Encrypt SSL certificates** using Caddy.

### 1. DNS Configuration
At your domain registrar (Namecheap, Cloudflare, GoDaddy, Porkbun):
* Add an **A Record**:
  * **Type:** `A`
  * **Name / Host:** `git` (for `git.yourdomain.com`)
  * **Value:** Your Public IPv4 address (find via `curl ifconfig.me`)
  * **TTL:** `Automatic` or `300s`

---

### 2. Sunrise Connect Box 3 Port Forwarding Setup

1. Open your browser and navigate to `http://192.168.1.1` (the Sunrise Connect Box 3 admin portal).
2. Log in using the settings password on the sticker under your modem.
3. In the left sidebar, navigate to **`Advanced settings`** → **`Security`** → **`Port forwarding`**.
4. Click **`Add rule`** and configure two forwarding rules for your server's local IP (e.g. `192.168.1.114`):

#### Rule 1: HTTP / ACME SSL Validation
* **Local IP:** `192.168.1.114` • **Ports:** `80` → `80` • **Protocol:** TCP • **Enabled:** On

#### Rule 2: HTTPS / Secure Web & Git Traffic
* **Local IP:** `192.168.1.114` • **Ports:** `443` → `443` • **Protocol:** TCP • **Enabled:** On

5. Click **Apply changes**.

> **Note on Sunrise DS-Lite:** If the "Port forwarding" option is missing, your connection is in IPv6 DS-Lite mode. Call Sunrise Support and request a public IPv4 Dual-Stack profile — free, ~10 minutes.

---

### 3. Caddy Reverse Proxy Configuration

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

---

## 🧩 Plugins

Plugins ship inside the repo but stay dormant until the two-layer gate opens.

### Activation layers
| Layer | Who | Where it lives |
| --- | --- | --- |
| **Server gate** | operator | which bundled plugins the instance serves |
| **User toggle** | any logged-in user | `/plugins` (off by default) |

A plugin is only *live* when **both** allow it. All activation state, plugin configs, assistant profiles, chat sessions, and the passkey vault are stored **server-side in Postgres** via nixre-core's account API — everything follows the account across browsers and devices. A one-time migration uploaded any `localStorage`-era data on first login after the switch.

### Bundled plugins
| Plugin | What it does | Configuration |
| --- | --- | --- |
| **Nixre Assistant** | AI copilot for agentic engineering work. Runs in an isolated Docker environment with the tools `file_read` (reads images too), `file_write`, `bash`, `run_tests`, `web_search`, and `git`. Per-repo profiles choose the AI provider and what it may do (edit, run bash/tests, push, merge, auto-merge-on-green, auto-fix bugs, path allow/block lists). | per-repo profile (`/plugins` + repo **Settings**) |
| **CI/CD Pipelines** | Pipeline status surface (webhook-based; no bundled CI runner). | settings form |
| **Security Scanner** | Scan repos/PRs for secrets, dependency CVEs, and static-analysis issues. | settings form |
| **Issues Tracker** | Create, list, assign, label and close issues. | settings form |
| **Code Review** | Inline, line-level review threads with auto-assignment and required reviewers. | settings form |
| **Members & Access** | Manage space members, roles, and per-repo permissions. | settings form |
| **Webhooks & Integrations** | Subscribe repo events to signed external URLs (Slack, Discord, …). | settings form |

### Adding a plugin
1. Describe it in `ui/src/lib/plugins.ts` (id, name, icon, category, tools, `profileFields`/`accessFields`, and whether it is repo-scoped).
2. It appears on `/plugins` once the operator flips the server gate on.
3. Render its surface with `PluginConfigForm` (generic key/value) or `AssistantProfileForm` (provider + per-repo access).

---

## 🏗️ Project Architecture

```
Nixre Architecture (sovereign — no external forge)
 ├── ui/                            # React + TypeScript + Tailwind SPA
 │    ├── src/lib/api.ts            # REST client → nixre-core only
 │    ├── src/lib/syncApi.ts        # Account-state client (prefs, chats, passkeys)
 │    ├── src/lib/plugins.ts        # Plugin registry
 │    ├── src/lib/assistant*        # Assistant engine + profiles (server-backed)
 │    ├── src/components/           # PullRequestForm/Detail, ChatSurface, PluginToggle, ...
 │    ├── src/pages/                # Views (RepoView, Settings, Admin, Plugins, ...)
 │    └── dist/                     # Production build output (committed)
 ├── backend/                       # nixre-core — the entire backend
 │    ├── src/routes/               # auth, sync, forge (spaces/repos/git), pullreq, account
 │    ├── src/git/                  # git CLI wrappers + Smart HTTP transport
 │    ├── src/lib/auth.js           # argon2, sessions, PATs
 │    └── src/db/migrations/        # SQL migrations (applied on boot)
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

`/api/v1`: `login` `register` `logout` `user` `webauthn/login` `admin/users` `user/publickeys` `user/tokens` `user/memberships` `spaces` `repos` (+ `content` `raw` `commits` `branches` `pullreq` sub-resources) `prefs` `conversations` `passkeys` — plus `/git/{space}/{repo}.git` Smart HTTP.

---

## 📜 License

MIT License © 2026 Nixre Contributors • [nixre.dev](https://nixre.dev)
