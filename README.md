# Nixre

> **Sovereign, minimalist, and ultra-fast code collaboration forge.**  
> Hosted at **[nixre.dev](https://nixre.dev)**

Nixre is a modern open-source Git forge that combines the **clean, typography-driven aesthetic of Radicle and Linear** with the **familiar workflows of GitHub** (Spaces, Pull Requests, Issues, and CI/CD).

---

## ✨ Highlights

- **🎨 Minimalist Radicle-Inspired UI**: Booton typography, JetBrains Mono code rendering, flat layout (`decard`), dark/light theme.
- **🔑 WebAuthn / Passkeys**: 1-click biometric sign-in using Touch ID, Face ID, Windows Hello, or YubiKey hardware tokens.
- **🛡️ 100% Unbranded & Sovereign**: No commercial upsell remarks, tracking, or proprietary vendor locks.
- **🔒 Auth Lock & Registration Controls**: Instant admin toggle to block public registrations and run a private, invite-only forge.
- **⚡ Git Smart HTTP Engine**: Fast cloning and pushing with standard `git clone` / `git push`.
- **🔄 GitHub-Style Pull Requests**: Side-by-side diff code reviews, branch comparisons, commit logs, and 1-click merging.
- **📁 Spaces & Organizations**: Multi-tenant workspace organization for projects and teams.
- **🚀 Native CI/CD Engine**: Declarative YAML build pipelines.

---

## 🛠️ Quick Start

### Running with Docker Compose

```bash
git clone https://github.com/lyani/nixre.git
cd nixre
docker compose up -d
```

Open `http://localhost:3000` in your browser.

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
