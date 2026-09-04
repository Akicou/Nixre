# AGENTS.md — Nixre & the cave rules

> **ME CAVEMAN.** Me write this so future agent (or sleepy me) no break Nixre.
> Nixre = self-host git forge. Live at **git.nixre.dev**. Own magic.
> Read this WHOLE thing before touch anything. Doing dumb thing make site go boom.

---

## What Nixre be

Git forge + AI helper + app deployer, all in one. One computer (this one) run it.

**Three big parts, all docker:**
- `nixre-core` — the brain. Does git, auth, AI, deploy. This where code changes matter most.
- `nixre-db` — postgres. Store users, repos, sessions, deploy stuff. Never touch directly unless know why.
- `nixre-ssh` — ssh for git. Small.

Plus:
- `nixre-web` — caddy. Serve the web page + API. Takes `/usr/share/caddy` (the `ui/dist` folder).
- Host caddy on port `3000`, tunnel (cloudflared) brings internet traffic.
- Deploy proxy on port `3003` — routes app traffic by host name.

**Files you see in this repo:**
- `backend/` — node src. The real logic.
- `ui/` — react frontend. `ui/dist` is the BUILT output (must commit it).
- `docker-compose.yml` — how everything start.
- `Caddyfile` — host web server rules.
- `scripts/` — helper shell scripts.
- `docs/`, `llms.txt`, `README.md` — words for humans + AI.
- `skills/` — the agent skill files (nixre skill). Public copy must be CLEANED (no live hostnames, no tunnel ids, no admin names).

---

## THE BIG RULES (dont break or regret)

1. **NEVER `reset --hard` here.** This branch have local commits not pushed yet. Reset = lose work = sad.
2. **`update-nixre.sh` NEVER wipe local commits.** It fast-forward. If it get stuck, stop and look by hand. Do not "fix" by deleting local work.
3. **Frontend changes:** edit in `ui/src`, then `npm run build` in `ui/`, then the new files land in `ui/dist/`. **You MUST commit `ui/dist`** (it's what gets served). Forgetting = web page show OLD version.
4. **Backend changes:** rebuild the docker image: `docker compose up -d --build nixre-core`. The backend is baked into the image (not live-reloaded). Change code + rebuild + restart, else new code never runs.
5. **Secrets live in `.env`** (local only). It is GITIGNORED. **NEVER commit `.env`** or past real tokens into commits — GitHub secret scanner blocks the push AND leaks password. If need doc, use `.env.example` (placeholder only). If a real secret got committed, `git filter-branch` it out and ROTATE the secret at the provider.
6. **Domain routing:** apps go through deploy proxy port `3003`, tunnel catches everything else. Don't wire A-records/port-forward — this router no port forward. All internet comes in via cloudflare tunnel.
7. **`nixre.dev` marketing repo is SEPARATE** (github.com/Akicou/nixre.dev). It has the landing page `index.html` + its own `llms.txt`. The forge repo `README.md`/`llms.txt` ALSO say the live instance. Keep them in sync.

---

## CAVEMAN SAY: what must change when thing happen

> Each line = "when THIS happen, YOU go change THOSE."

### If live instance hostname change (git.nixre.dev -> something-else)
- Change in THIS repo: `README.md`, `llms.txt` (the "Live Instance" line).
- Change in `nixre.dev` repo: `index.html` (4 spots: nav, hero button, body "live instance runs at", footer), `llms.txt` ("Live Instance" line).
- Also the "personal instance, registration closed" wording — update if that changes.
- Don't forget the skill files `skills/nixre/*` and the tunnel config — if host changes, tunnel ingress changes.

### If registration open/close
- `README.md`, `llms.txt`, `nixre.dev/index.html` all say "registration closed / personal instance". If it opens, change wording.
- `.env` `NIXRE_REGISTRATION_CLOSED` + admin console toggle (that is API state, not git).

### If add a feature to the UI
- Edit `ui/src/...`, then `cd ui && npm run build`, then commit `ui/dist`.
- Add a test in `ui/src/test/*.spec.tsx` (matches vibe of existing tests). Run `npx vitest run` before commit.
- Rebuild backend if backend changed.

### If add a backend endpoint / logic
- Edit `backend/src/...`, update `docker-compose` or `.env.example` if new env var.
- Rebuild: `docker compose up -d --build nixre-core`. Check `/healthz`.
- Add migration in `backend/src/db/migrations/` if DB change (numbered, next in sequence).

### If change the deployment feature
- Backend: `backend/src/routes/deployments.js`, `backend/src/lib/deploy*`.
- Frontend: `ui/src/pages/DeploymentsPage.tsx`, `ui/src/components/SpaceDeployments.tsx`, `DeploymentsOverview.tsx`, `ui/src/lib/api.ts`, `ui/src/lib/deployEvents.ts`.
- Docs: `docs/deployments.md`, README, llms.txt, plus `skills/nixre/references/deployments.md`.
- Rebuild backend + frontend. Test via deploy proxy `:3003`.

### If someone says "pubic still says nayhein.com"
- That stale text is in the `nixre.dev` REPO (`index.html`, `llms.txt`). Fix THERE, not in forge repo. Push `nixre.dev`. (Forge repo also needs the same fix in README/llms.)

### If push to github fails with "secret scanner" / "permission denied"
- **Permission denied 403:** the gh token (`github_pat_...`) probably no write. Switch remote to SSH (this server have a working `id_ed25519` key): `git remote set-url origin git@github.com:Akicou/Nixre.git`.
- **Secret scanner block:** a real secret got committed. Find it (look at the failing path in the error), strip it from history with `git filter-branch`, gitignore it, and ROTATE the secret at the provider. `.env` is the usual culprit — never commit it.

### If machine reboot / services down
- Check: `docker compose ps`, `curl 127.0.0.1:3001/healthz`, `systemctl --user status cloudflared-nixre`.
- If `nixre-core` not up, `docker compose up -d nixre-core` (db must be healthy first).
- Apps on deploy proxy come back via reconcile sweep (boot). Wait, check `docker ps` for `nixre-app-*`.

### If need to run the nixre skill scripts
- `cd skills/nixre && ./scripts/nixre-status.sh` (state), `nixre-logs.sh` (logs), `nixre-backup.sh` (pg_dump + tar).
- These scripts read values from env vars / placeholders in the PUBLIC copy. The real values live in `/opt/nixre/.env` and the private forge repo.

---

## WORDS OF WISDOM FROM CAVEMAN

- **The forge repo `main` is what's shown to the world on github.** Keep it clean, no secrets, docs correct.
- **`nixre.dev` is the marketing face.** Stale text there makes you look silly (me look silly, you look silly).
- **Build before push.** Untested UI change = broken page for everyone. Caveman test twice, push once.
- **Never commit `.env`.** Repeat it. Me say it again: **NEVER commit `.env`.**
- When in doubt, ask. Caveman me explain, then me act. Better slow + right than fast + broken.
