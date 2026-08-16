# Nixre

> **Sovereign, minimalist, and ultra-fast code collaboration forge.**  
> Official site: **[nixre.dev](https://nixre.dev)** • Live Instance: **[git.nayhein.com](https://git.nayhein.com)**

Nixre is a modern open-source Git forge that combines the **clean, typography-driven aesthetic of Radicle and Linear** with the **familiar workflows of GitHub** (Spaces, Pull Requests, Issues, and CI/CD).

---

## ✨ Features

- **🎨 Minimalist Radicle-Inspired UI**: Booton typography, JetBrains Mono code rendering, flat layout (`decard`), dark/light theme.
- **🔑 WebAuthn / Passkeys**: 1-click biometric sign-in using Touch ID, Face ID, Windows Hello, or YubiKey hardware tokens.
- **🛡️ 100% Sovereign & Unbranded**: Zero commercial upsell remarks, enterprise tracking, or proprietary vendor locks.
- **🔒 Auth Lock & Registration Controls**: Instant admin toggle in the Admin Console to block public registrations and run a private, invite-only forge.
- **⚡ Git Smart HTTP Engine**: Fast cloning and pushing with standard `git clone` / `git push`.
- **🔄 GitHub-Style Pull Requests**: Side-by-side diff code reviews, branch comparisons, commit logs, and 1-click merging.
- **📁 Spaces & Organizations**: Multi-tenant workspace organization for projects and teams.
- **🚀 Native CI/CD Engine**: Declarative YAML build pipelines.

---

## 🛠️ Quick Start

### Running with Docker Compose

```bash
git clone https://github.com/Akicou/Nixre.git
cd Nixre
docker compose up -d
```

Open `http://localhost:3000` in your browser.

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
3. In the left sidebar, navigate to **`Advanced settings`** $\rightarrow$ **`Security`** $\rightarrow$ **`Port forwarding`**.
4. Click **`Add rule`** and configure two forwarding rules for your server's local IP (e.g. `192.168.1.114`):

#### Rule 1: HTTP / ACME SSL Validation
* **Local IP:** `192.168.1.114`
* **Local Start/End Port:** `80` - `80`
* **External Start/End Port:** `80` - `80`
* **Protocol:** `TCP` (or `Both`)
* **Enabled:** `On`

#### Rule 2: HTTPS / Secure Web & Git Traffic
* **Local IP:** `192.168.1.114`
* **Local Start/End Port:** `443` - `443`
* **External Start/End Port:** `443` - `443`
* **Protocol:** `TCP` (or `Both`)
* **Enabled:** `On`

5. Click **Apply changes**.

> **Note on Sunrise DS-Lite:** If the "Port forwarding" option is missing from your Connect Box 3 dashboard, your connection is in IPv6 DS-Lite mode. Call Sunrise Support (0800 707 707) and request to *"switch my Connect Box 3 to a public IPv4 Dual-Stack profile"*. It is free and takes ~10 minutes.

---

### 3. Caddy Reverse Proxy Configuration

In your `Caddyfile`:

```caddyfile
git.yourdomain.com {
    handle /api/* {
        reverse_proxy 127.0.0.1:3001
    }
    handle /git/* {
        reverse_proxy 127.0.0.1:3001
    }
    handle {
        root * /opt/nixre/ui/dist
        try_files {path} /index.html
        file_server
    }
}
```

Restart Caddy (`sudo systemctl restart caddy`). Caddy will automatically complete the ACME HTTP-01 challenge through the Sunrise box and serve your trusted HTTPS certificate.

---

## 🏗️ Project Architecture

```
Nixre Architecture
 ├── ui/                  # React + TypeScript + Tailwind + Radicle Design System
 │    ├── src/lib/api.ts         # REST API client
 │    ├── src/lib/webauthn.ts    # FIDO2 / WebAuthn Passkeys vault
 │    ├── src/pages/             # Modern views (RepoView, PullRequests, Settings, Admin)
 │    └── dist/                  # Production build output
 ├── docker-compose.yml   # Unified container stack
 └── Caddyfile            # Reverse proxy & static SPA handler
```

---

## 📜 License

MIT License © 2026 Nixre Contributors • [nixre.dev](https://nixre.dev)
