# Nixre Sovereignty Plan — Replacing Gitness End to End

**Goal:** Nixre becomes a sovereign forge with zero external forge dependencies.
One codebase, one database, one git engine — all owned by Nixre. No Gitness.

**Current state:** the UI (React SPA) talks to Gitness for auth, spaces, repos,
git data, and pull requests; `nixre-sync` (Node + Postgres) already owns
account-scoped UI state (prefs, chats, passkeys) with Gitness-delegated auth.

**End state:** a single `nixre-core` backend (Node + Postgres + on-disk bare
git repos) serves everything at `/api/v1` plus git transport at `/git/*`.
Gitness is removed from the stack entirely.

---

## 1. What Gitness actually provides today (audit)

Every Gitness dependency in Nixre, from `ui/src/lib/api.ts` (28 methods):

| Area | Methods | Where used |
|---|---|---|
| Auth | `login`, `register`, `currentUser`, `logout` | Login/Register pages, App boot |
| Spaces | `listSpaces` (via `/user/memberships`), `getSpace`, `createSpace` | Dashboard, Navbar, SpaceView, NewSpace |
| Repos | `listRepos`, `getRepo`, `createRepo`, `updateRepo`, `deleteRepo` | Dashboard, RepoView, NewRepo, RepoSettingsPanel |
| Git data | `getTree`, `getRawBlob`, `getCommits`, `getBranches` | RepoView code browser, commits tab, branches tab |
| Pull requests | `listPullRequests`, `getPullRequest`, `createPullRequest`, `mergePullRequest`, `getPullRequestDiff` | PR tab, PullRequestForm, PullRequestDetail, Assistant PR panel |
| Account | `listPublicKeys`, `addPublicKey`, `deletePublicKey`, `listTokens`, `createToken`, `deleteToken` | Settings (SSH keys, tokens) |
| Admin | `listUsers` | AdminView |
| Git transport | Smart HTTP `/git/{space}/{repo}.git`, SSH port 3022 | clone URLs shown in UI; actual clone/push |
| CI | Gitness pipelines (`--enable-ci`, docker.sock) | **unused** — only referenced in plugin copy |

Also: `FileDiff.patch` is consumed as a **base64-encoded unified diff**
(`ui/src/lib/diff.ts`), and the login flow expects a flat `{access_token}` JSON.

**Everything else in Gitness — pipelines, gitspaces, connectors, templates,
rules, labels, webhooks, import/export — is dead weight for Nixre.** The real
replacement surface is: 4 auth + 3 space + 5 repo + 4 git + 5 PR + 6 account +
1 admin endpoints, one Smart-HTTP git route, and (optionally) SSH.

---

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

**Why this shape:**
- **Node + Express** — same stack as nixre-sync (team/tooling reuse); git
  operations via the real `git` CLI (`ls-tree`, `cat-file`, `log`,
  `for-each-ref`, `diff`, `merge`) and `git-http-backend` for Smart HTTP.
  Shelling out to git is what keeps this a 3-month project instead of a
  year; git does the hard parts correctly.
- **Postgres for all metadata**, bare repos on a volume for git objects —
  the same split Gitea/GitLab use. Git data never enters the DB.
- **nixre-sync is absorbed** into nixre-core as one more router; its tables
  move verbatim. Auth becomes first-party (argon2 + DB sessions or JWT) —
  the token-validation hop against Gitness disappears.
- **Caddy stays** as TLS/entrypoint; the dev Vite proxy just retargets.

---

## 3. nixre-core service — modules and endpoints

### 3.1 Auth (replaces Gitness accounts)
- `users` table: uid (PK), email, display_name, password_hash (argon2id),
  admin, blocked, created, updated — **same field names the UI already reads**.
- `sessions` table + opaque bearer tokens (DB-backed, revocable). `POST /login`
  returns `{access_token}` exactly as the UI expects; `GET /user` returns the
  flat user object (uid/email/display_name/admin/…) — matching today's shape.
- `register`, `logout` (revoke session), `GET /user`.
- WebAuthn passkey **login**: extend `authenticatePasskey` flow to issue a
  session (challenge stored server-side; vault rows already exist).
- First registered user becomes admin (preserves current behavior).

### 3.2 Spaces
- `spaces` table: uid, description, is_public, created_by.
- `space_members` table; `GET /user/memberships` shape preserved
  (`[{space:{…}}]` as the UI maps it — or simplify to flat and adjust
  `listSpaces` in the adapter, see §4).
- `GET/POST /spaces`, `GET /spaces/{ref}`.

### 3.3 Repos
- `repos` table: id, space_id, uid, description, is_public, default_branch,
  created_at, updated_at. Unique (space_id, uid). Path = `{space}/{repo}`.
- Creating a repo = insert row + `git init --bare /data/repos/{space}/{repo}.git`
  (+ optional initial commit with README via temp clone, as `createRepo`
  does today).
- Deleting = drop row + `rm -rf` the bare dir (behind a confirm, as the UI
  already enforces).
- `GET /repos?space=`, `GET/POST/PATCH/DELETE /repos/{ref}` — response fields
  mapped to the UI's `Repository` interface (`git_url`, `git_ssh_url`,
  `num_open_pulls` computed).

### 3.4 Git data (the heart)
All read via git CLI against the bare repo, output parsed to JSON:
- `GET /repos/{ref}/content/{path}?ref=` → `getTree` (ls-tree) /
  `getRawBlob` (cat-file -p + size). Base64 for binary blobs as today.
- `GET /repos/{ref}/commits?ref=&page=` → `git log --format` parsed into the
  UI's `Commit` shape (sha, message, author name/email, date).
- `GET /repos/{ref}/branches` → `git for-each-ref refs/heads` (+ ahead/behind
  vs default branch via `rev-list --left-right --count`).
- `GET /repos/{ref}/diff/{range}` → `git diff --cached`-style unified diff
  per file, wrapped into `FileDiff` rows; **`patch` base64-encoded** so
  `ui/src/lib/diff.ts` works unchanged.

### 3.5 Git transport
- **Smart HTTP:** Caddy `/git/*` → nixre-core route that spawns
  `git http-backend` (CGI) with the right env (GIT_PROJECT_ROOT,
  PATH_INFO, AUTH). Auth = same bearer/session (basic-auth fallback for git
  clients: `git:user-token` as password). Per-repo ACL: public read,
  member write.
- **SSH (optional, phase 4):** `nixre-ssh` container running sshd with
  `AuthorizedKeysCommand` hitting core (`/internal/keys/{uid}`) — the
  `listPublicKeys`/`addPublicKey` data becomes real. ForcedCommand
  `git-shell` restricted to owned repos.

### 3.6 Pull requests
- Tables: `pull_requests` (number per repo, title, description, source_branch,
  target_branch, state open/merged/closed, author, merged_by, timestamps),
  computed counts feed `num_open_pulls`.
- `GET/POST /repos/{ref}/pullreq`, `GET …/pullreq/{n}`,
  `POST …/pullreq/{n}/merge`, `GET …/pullreq/{n}/diff` (three-dot diff
  via merge-base + `git diff base...head`).
- **Merge methods:** merge (temp clone + `git merge --no-ff` + push),
  squash (`git merge --squash` + commit), rebase (`git rebase` + push).
  Post-merge: update default branch ref, mark PR merged, delete source
  branch if requested (UI checkbox exists? — keep branch, simplest).
- PR comments/reviews: **out of scope for v1** (UI doesn't render them yet);
  add `pr_comments` table later when the UI grows a timeline.

### 3.7 Account (keys, tokens)
- `public_keys` table (identifier, content parsed/validated server-side,
  fingerprint). Endpoints mirror today's shapes.
- `tokens` table: identifier, hash of secret, issued_at, expires_at;
  `POST` returns plaintext once (like Gitness). Session vs PAT distinguished
  by type — both validate through the same middleware.
- `GET /admin/users` gated on `admin=true` (AdminView keeps working).

### 3.8 Sync (absorbed)
- The entire existing `/api/sync/v1` router moves in as `/api/v1/…/prefs|`
  `conversations|passkeys` (keep a compat alias at `/api/sync/v1` during
  migration). Tables unchanged. Auth middleware swaps its Gitness-validation
  hop for first-party session lookup.

### 3.9 Webhooks (phase 4)
- `repo_webhooks` table + `POST /repos/{ref}/webhooks`; fire on push/PR
  events via a small queue. Powers the CI/CD plugin honestly (pipeline
  status = webhook receiver + log store) instead of Gitness pipelines.

---

## 4. UI adaptations (deliberately small)

The SPA keeps its TypeScript interfaces (`User`, `Space`, `Repository`,
`TreeEntry`, `Commit`, `Branch`, `PullRequest`, `FileDiff`, …) —
**only the transport in `api.ts` changes.** Two options:

- **A (recommended): adapter endpoint-shape parity.** nixre-core returns
  JSON in exactly the shapes the UI reads today (including base64 patches
  and `/user/memberships` wrapping). `api.ts` changes ~10 lines of base URL;
  pages and tests untouched.
- **B: clean API + rewrite client.** Prettier endpoints, but every page,
  fixture, and spec that touches shapes needs review. Do this only if we
  want to shed Gitness-isms like the memberships wrapper.

Concrete UI diffs under option A:
1. `api.ts`: point at `/api/v1` served by core (same path, new impl);
   remove the 401→redirect only if behavior differs (keep it).
2. Login page: passkey flow now hits core (`/webauthn/login`) — swap URL.
3. `diff.ts`: unchanged (base64 contract kept).
4. `syncApi.ts`: base path alias or 1-line change.
5. Dashboard/RepoView clone URLs: `/git/...` unchanged (Caddy routes to core).
6. Fixtures/tests: unchanged (shapes identical).

---

## 5. Infra changes

| File | Change |
|---|---|
| `docker-compose.yml` | remove `harness/gitness`; `nixre-core` build from `backend/` (absorbs sync); `nixre-db` stays; add `nixre-ssh` (phase 4); `nixre-web` Caddy unchanged routes |
| `backend/` | grows from sync-only (~350 LOC) to core: `src/routes/{auth,spaces,repos,gitdata,pullreq,account,admin,sync}.js`, `src/git/` CLI wrappers, `src/db/` migrations |
| `Caddyfile` | `/git/*` → nixre-core (was backend) |
| `ui/vite.config.ts` | dev proxy `/api` + `/git` → core port |
| `README.md` | stack diagram, "sovereign end to end", remove Gitness mentions |
| new `migrations/` | SQL migrations for the full schema (users…webhooks) |

**Migration of existing data** (one-time script `scripts/migrate-from-gitness.js`):
for each repo in Gitness API: create space+repo rows, then
`git clone --mirror http://old-gitness/... target.git` — full history,
branches, tags preserved. Users/tokens: re-register or export/import via
admin endpoints. PR history: **not migrated** (Gitness PR data is
non-essential; note in docs).

---

## 6. Phase plan (each phase ships green)

**Phase 0 — prep (½ day).**
Rename/absorb `nixre-sync` into `backend/` as the seed of core (routes
split, migrations framework, healthz). No behavior change. Docker still
optional.

**Phase 1 — first-party auth (2–3 days).**
Users/sessions/tokens tables, argon2, login/register/logout/user endpoints
(shape-compatible). WebAuthn login issues sessions. UI switches auth base to
core. Gitness still serves everything else. Tests: auth integration spec.

**Phase 2 — spaces, repos, git storage (3–4 days).**
Tables + CRUD + `git init --bare`; tree/blob/commits/branches endpoints via
git CLI. UI repo browser fully on core. Smart HTTP push/pull via
`git http-backend` with basic-auth PATs. Clone URLs live. Integration tests:
init → commit → clone → read tree via API.

**Phase 3 — pull requests (3–4 days).**
PR tables, list/get/create/diff/merge (merge + squash first, rebase after).
`num_open_pulls`. UI PR tab + Assistant PR panel on core. This deletes the
last Gitness API dependency.

**Phase 4 — cutover (1–2 days).**
Remove Gitness container; migration script; README rewrite; move sync
endpoints under `/api/v1`; full-suite pass; tag `v1.0-sovereign`.

**Phase 5 (post-sovereignty, optional).**
SSH (`nixre-ssh` + AuthorizedKeysCommand), webhooks + honest CI plugin,
PR comments timeline, email notifications.

**Total: ~2–3 weeks of focused work.** Each phase is independently
deployable — Gitness keeps running until Phase 4 pulls the plug.

---

## 7. Risks & honest trade-offs

- **Git correctness via CLI:** parsing `git log/ls-tree/diff` output is
  stable but needs quoting/pathspec care (evil filenames). Mitigate with
  `-z` and structured formats (`--format` with unit separators) everywhere.
- **Smart HTTP:** `git http-backend` is battle-tested; the risk is auth/ACL
  wiring. Test matrix: clone public/private, push member/non-member,
  token expiry mid-push.
- **LFS:** not supported in v1 (Gitness barely did either). Document.
- **CI:** gone with Gitness. The pipeline plugin becomes webhook-based
  (phase 5) or is re-scoped. Be explicit in README — "no bundled CI" is a
  feature of the minimalist build, not a gap.
- **Scale:** fine for teams/small orgs (metadata in Postgres, git on disk);
  not a GitHub-scale sharding story. Acceptable by design.
- **PR import:** historical PRs from the Gitness era are not migrated.

## 8. Definition of done

- [ ] `docker compose up` yields Nixre with zero Gitness images
- [ ] register → create space → create repo → clone via HTTPS → push →
      see commit in UI → open PR → diff renders → merge → default branch
      updated — all against nixre-core only
- [ ] Passkeys, chat sessions, plugin prefs, SSH keys, PATs all persist in
      Postgres and survive container recreation
- [ ] UI test suite green; new backend integration suite green
- [ ] README documents the sovereign stack with no forge dependencies
