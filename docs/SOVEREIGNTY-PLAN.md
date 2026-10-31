# Nixre sovereignty plan: replacing Gitness

> **Status: complete.** This is the historical plan that removed Gitness, written in the tense it was authored in. Nixre now runs a single `nixre-core` backend (Node + Postgres + on-disk bare git repos) serving `/api/v1` and `/git/*`, with no Gitness image in `docker-compose.yml`.
>
> For the current architecture see [`README.md`](../README.md) and [`llms.txt`](../llms.txt). The only Gitness reference left is `scripts/migrate-from-gitness.js`, a one-time tool for operators coming from a legacy install.

**Goal:** no external forge dependencies. One codebase, one database, one git engine.

**Original state:** the React SPA used Gitness for auth, spaces, repos, git data, and pull requests. `nixre-sync` (Node + Postgres) held prefs, chats, and passkeys and delegated auth to Gitness.

**End state:** `nixre-core` serves everything at `/api/v1` plus git transport at `/git/*`.

## 1. Gitness surface used

From `ui/src/lib/api.ts` (28 methods):

| Area | Methods |
|---|---|
| Auth | `login`, `register`, `currentUser`, `logout` |
| Spaces | `listSpaces` (via `/user/memberships`), `getSpace`, `createSpace` |
| Repos | `listRepos`, `getRepo`, `createRepo`, `updateRepo`, `deleteRepo` |
| Git data | `getTree`, `getRawBlob`, `getCommits`, `getBranches` |
| Pull requests | `listPullRequests`, `getPullRequest`, `createPullRequest`, `mergePullRequest`, `getPullRequestDiff` |
| Account | `listPublicKeys`, `addPublicKey`, `deletePublicKey`, `listTokens`, `createToken`, `deleteToken` |
| Admin | `listUsers` |
| Git transport | Smart HTTP `/git/{space}/{repo}.git`, SSH port 3022 |

Gitness CI (`--enable-ci`, docker.sock) was unused. `FileDiff.patch` is consumed as a base64-encoded unified diff (`ui/src/lib/diff.ts`), and login expects flat `{access_token}` JSON. Other Gitness features (pipelines, gitspaces, connectors, templates, rules, labels, webhooks, import/export) were not used.

## 2. Target architecture

```
                       ┌────────────────────────────────────────────┐
   browser ── HTTP ──▶ │ Caddy :3000                                │
                       │   /api/*   → nixre-core :3000              │
                       │   /git/*   → nixre-core :3000 (smart HTTP) │
                       │   /*       → static SPA (ui/dist)          │
                       └──────────────┬─────────────────────────────┘
                                      │
                       ┌──────────────▼──────────────┐      ┌──────────────┐
                       │ nixre-core (Node/Express)   │      │ nixre-db     │
                       │  • REST API (all of §1)     │─────▶│ PostgreSQL   │
                       │  • auth: argon2 + sessions  │      │ users, spaces│
                       │  • sync API (absorbed)      │      │ repos, PRs,  │
                       │  • git: bare repos on disk  │      │ prefs, convos│
                       │    via git CLI + http-backend│     │ passkeys, …  │
                       └──────────────┬──────────────┘      └──────────────┘
                                      │
                       ┌──────────────▼──────────────┐
                       │ volume /data/repos          │
                       │  {space}/{repo}.git (bare)  │
                       └─────────────────────────────┘
   ssh :3022 ─────────▶ nixre-ssh (openssh, authorized_keys from DB)
```

Decisions:
- Node + Express, same stack as nixre-sync. Git operations use the `git` CLI (`ls-tree`, `cat-file`, `log`, `for-each-ref`, `diff`, `merge`) and `git-http-backend` for Smart HTTP.
- Postgres holds metadata. Git objects stay in bare repos on a volume.
- nixre-sync is absorbed into nixre-core as a router, tables unchanged. Auth is first-party (argon2 + DB sessions), replacing the Gitness token-validation hop.
- Caddy stays as the TLS entrypoint. The dev Vite proxy is retargeted.

## 3. nixre-core modules

- **Auth:** `users` table (uid, email, display_name, password_hash argon2id, admin, blocked, created, updated; same field names the UI reads). `sessions` table with opaque, revocable bearer tokens. `POST /login` returns `{access_token}`. `GET /user` returns the flat user object. Also `register` and `logout`. Passkey login extends `authenticatePasskey` to issue a session. The first registered user becomes admin.
- **Spaces:** `spaces` (uid, description, is_public, created_by) and `space_members`. `GET /user/memberships` keeps its `[{space:{…}}]` shape. `GET/POST /spaces`, `GET /spaces/{ref}`.
- **Repos:** `repos` (id, space_id, uid, description, is_public, default_branch, created_at, updated_at), unique (space_id, uid). Create inserts a row, runs `git init --bare /data/repos/{space}/{repo}.git`, and optionally adds a README commit via temp clone. Delete drops the row and removes the bare dir. `GET /repos?space=`, `GET/POST/PATCH/DELETE /repos/{ref}`, mapped to the UI's `Repository` interface (`git_url`, `git_ssh_url`, computed `num_open_pulls`).
- **Git data** (git CLI against the bare repo):
  - `GET /repos/{ref}/content/{path}?ref=`: `ls-tree` for `getTree`, `cat-file -p` plus size for `getRawBlob`. Binary blobs are base64.
  - `GET /repos/{ref}/commits?ref=&page=`: `git log --format` parsed into `Commit`.
  - `GET /repos/{ref}/branches`: `git for-each-ref refs/heads`, plus ahead/behind via `rev-list --left-right --count`.
  - `GET /repos/{ref}/diff/{range}`: per-file unified diff as `FileDiff` rows, `patch` base64-encoded.
- **Git transport:** Caddy `/git/*` goes to a core route that spawns `git http-backend` (CGI). Auth is the same bearer/session, with basic-auth fallback for git clients (`git:user-token` as password). ACL: public read, member write. Optional SSH (phase 4): `nixre-ssh` runs sshd with `AuthorizedKeysCommand` calling `/internal/keys/{uid}` and ForcedCommand `git-shell`.
- **Pull requests:** `pull_requests` table (number per repo, title, description, source_branch, target_branch, state open/merged/closed, author, merged_by, timestamps). `GET/POST /repos/{ref}/pullreq`, `GET …/pullreq/{n}`, `POST …/pullreq/{n}/merge`, `GET …/pullreq/{n}/diff` (merge-base + `git diff base...head`). Merge methods: merge (temp clone, `git merge --no-ff`, push), squash (`git merge --squash` + commit), rebase (`git rebase` + push). The source branch is kept. PR comments and reviews are out of scope for v1.
- **Account:** `public_keys` (identifier, validated content, fingerprint). `tokens` (identifier, secret hash, issued_at, expires_at); `POST` returns the plaintext once. Sessions and PATs share one middleware. `GET /admin/users` requires `admin=true`.
- **Sync:** `/api/sync/v1` moves to `/api/v1/…/prefs|conversations|passkeys`, with a compat alias at `/api/sync/v1` during migration. Auth middleware uses session lookup.
- **Webhooks (phase 4):** `repo_webhooks` table and `POST /repos/{ref}/webhooks`, fired on push/PR events through a small queue. The CI/CD plugin builds on these instead of Gitness pipelines.

## 4. UI adaptation

The SPA keeps its TypeScript interfaces and only the transport in `api.ts` changes. Option A (recommended): nixre-core returns the shapes the UI reads today (base64 patches, `/user/memberships` wrapper), so `api.ts` changes about 10 lines of base URL and pages and tests are untouched. Option B is a clean API plus client rewrite, only worthwhile to shed Gitness-isms. nixre-core follows option A.

Under option A: `api.ts` points at `/api/v1` and keeps the 401 redirect; the passkey flow hits `/webauthn/login`; `diff.ts` is unchanged; `syncApi.ts` gets a base path alias or 1-line change; `/git/...` clone URLs are unchanged.

## 5. Infra changes

| File | Change |
|---|---|
| `docker-compose.yml` | remove `harness/gitness`; `nixre-core` builds from `backend/`; `nixre-db` stays; add `nixre-ssh` (phase 4); `nixre-web` routes unchanged |
| `backend/` | grows from sync-only (~350 LOC) to core: `src/routes/{auth,spaces,repos,gitdata,pullreq,account,admin,sync}.js`, `src/git/` CLI wrappers, `src/db/` migrations |
| `Caddyfile` | `/git/*` → nixre-core |
| `ui/vite.config.ts` | dev proxy `/api` + `/git` → core port |
| `README.md` | update stack diagram, remove Gitness mentions |
| new `migrations/` | SQL migrations for the full schema |

`scripts/migrate-from-gitness.js` creates space and repo rows for each Gitness repo, then runs `git clone --mirror http://old-gitness/... target.git` (full history, branches, tags). Users and tokens are re-registered or moved through admin endpoints. PR history is not migrated.

## 6. Phases

Each phase shipped green. Gitness kept running until phase 4.

- **Phase 0, prep:** absorb `nixre-sync` into `backend/` (routes split, migrations framework, healthz).
- **Phase 1, auth:** users/sessions/tokens tables, argon2, shape-compatible auth endpoints, passkey login issuing sessions, UI auth base switched to core.
- **Phase 2, spaces, repos, git storage:** CRUD, `git init --bare`, tree/blob/commits/branches endpoints, Smart HTTP push/pull with basic-auth PATs. Tests: init, commit, clone, read tree via API.
- **Phase 3, pull requests:** PR tables and list/get/create/diff/merge (merge and squash first, rebase after), `num_open_pulls`. This removed the last Gitness API dependency.
- **Phase 4, cutover:** remove the Gitness container, add the migration script, rewrite the README, move sync endpoints under `/api/v1`, tag `v1.0-sovereign`.
- **Phase 5, optional:** SSH, webhooks and CI plugin, PR comments timeline, email notifications.

The estimate at the time was 2-3 weeks.

## 7. Risks

- Git CLI output parsing needs care with unusual filenames. Use `-z` and `--format` with unit separators.
- Smart HTTP risk is auth/ACL wiring. Test matrix: clone public/private, push member/non-member, token expiry mid-push.
- LFS is not supported in v1.
- CI is gone with Gitness. The pipeline plugin becomes webhook-based (phase 5) or is re-scoped.
- Scale: suited to teams and small orgs, no sharding.
- Historical Gitness PRs are not imported.

## 8. Definition of done

- [ ] `docker compose up` yields Nixre with zero Gitness images
- [ ] register → create space → create repo → clone via HTTPS → push → see commit in UI → open PR → diff renders → merge → default branch updated, all against nixre-core only
- [ ] Passkeys, chat sessions, plugin prefs, SSH keys, PATs persist in Postgres and survive container recreation
- [ ] UI test suite green; new backend integration suite green
- [ ] README documents the stack with no forge dependencies
