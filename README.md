# Nixre

> **Sovereign, minimalist, and ultra-fast code collaboration forge.**  
> Official site: **[nixre.dev](https://nixre.dev)** • Live Instance: **[git.nayhein.com](https://git.nayhein.com)**

Nixre is a modern open-source Git forge that is **100% sovereign end to end**: its own backend (**nixre-core**, Node + PostgreSQL), its own git storage (bare repositories on disk with Smart HTTP transport), its own auth (argon2 + sessions + passkeys + PATs). No Gitness, no external forge dependency, no vendor locks — one codebase, one database, one git engine, all owned by Nixre.

---

## ✨ Features

- **🎨 Minimalist Radicle-Inspired UI**: Booton typography, JetBrains Mono code rendering, flat layout (`decard`), dark/light theme.
- **🛡️ 100% Sovereign**: nixre-core owns auth, spaces, repos, git transport, pull requests, and account data. Zero external forge APIs.
- **🔑 Passkeys**: WebAuthn device credentials stored server-side in your account; a passkey can open a brand-new session.
- **⚡ Git Smart HTTP + SSH**: Clone/push over HTTPS (`/git/<space>/<repo>.git`) with session/PAT basic-auth, or SSH (`ssh://git@host:3022/<space>/<repo>.git`) with your account's registered keys. Real git, real history.
- **🔄 Pull Requests**: create PRs between branches, view unified diffs per changed file, merge (`--no-ff`) or squash with one click.
- **📡 Signed Webhooks**: subscribe `push` and `pull_request` events to external URLs; deliveries are HMAC-SHA256 signed (`X-Nixre-Signature`) with automatic retries and a delivery log.
- **📁 Spaces & Organizations**: multi-tenant workspaces with membership-based access control.
- **🔐 Personal Access Tokens & SSH Keys**: mint PATs (returned once, stored hashed) and manage SSH public keys with fingerprints.
- **🧩 Plugin System**: bundled plugins that stay inert until enabled — the Nixre Assistant, an AI engineering copilot. All plugin state is account-scoped and server-persisted.

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
| `nixre-core` | The entire backend: REST API, auth, git Smart HTTP (via `git http-backend`), PR merges, webhook delivery |
| `nixre-ssh` | SSH git transport: sshd with core-resolved keys (AuthorizedKeysCommand), every session locked to a per-key git-shell wrapper |
| `nixre-db` | PostgreSQL: users, sessions, tokens, spaces, repos, pull requests, webhooks, plugin prefs, chats, passkeys |

Git objects live as bare repositories on the `./data/repos` volume; Postgres holds metadata only (the same split Gitea/GitLab use).

### Cloning

```bash
# HTTPS — username is your uid, password a session token or PAT (Settings → Tokens)
git clone http://<host>/git/<space>/<repo>.git

# SSH — register a public key in Settings → Passkeys/SSH, then:
git clone ssh://git@<host>:3022/<space>/<repo>.git
```

### Webhooks

Create one via the API (`POST /api/v1/repos/<space>/<repo>/+/webhooks` with `{url, events}`); the response contains the signing secret (shown once). Deliveries post JSON with `X-Nixre-Event` and `X-Nixre-Signature: sha256=…` (HMAC-SHA256 of the raw body, keyed by the secret) and retry with backoff up to 5 attempts; inspect history at `GET …/webhooks/<id>/deliveries`.

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
| **Nixre Assistant** | AI copilot for agentic engineering work. Add **multiple providers** — DeepSeek, OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint — each validated against the live provider with its model list fetched automatically; you pick which models are enabled for chat and which provider is active. API keys are stored **encrypted server-side** (never sent to the browser). Streaming chat in four modes (Ask, Plan, Agent, Debug) with configurable reasoning levels and interleaved thinking, available on the dashboard and per-repo; chat requests route to the provider that owns the selected model. The agent can read files, search code, show images, run shell commands in a fresh clone of the repo, and search the web — each gated by a per-repo access profile. A validated provider is required — there is no offline fallback. | per-repo profile (`/plugins` + repo **Settings**) |

Everything else a forge needs is a first-class feature, not a plugin: **webhooks** (signed, with retries and a delivery log), **spaces & members**, **pull requests**, and **SSH keys / PATs** all live in nixre-core directly.

### Adding a plugin
1. Describe it in `ui/src/lib/plugins.ts` (id, name, icon, category, tools, `providerFields`/`accessFields`, and whether it is repo-scoped).
2. It appears on `/plugins` once the operator flips the server gate on.
3. Render its surface with `PluginConfigForm` (generic key/value) or `AssistantProfileForm` (provider + per-repo access).

A plugin is only listed in the registry when it ships a real backend path — its UI writes to nixre-core and the server enforces it. There are no prefs-only stubs.

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
 ├── ssh/                            # nixre-ssh — SSH git transport
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

`/api/v1`: `login` `register` `logout` `user` `webauthn/login` `admin/users` `user/publickeys` `user/tokens` `user/memberships` `spaces` `repos` (+ `content` `raw` `commits` `branches` `pullreq` sub-resources) `prefs` `conversations` `passkeys` — plus `/git/{space}/{repo}.git` Smart HTTP.

---

## 📜 License

MIT License © 2026 Nixre Contributors • [nixre.dev](https://nixre.dev)
