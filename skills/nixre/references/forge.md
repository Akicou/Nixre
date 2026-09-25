# Repos, spaces, pull requests, webhooks

Everything here is first-class in `nixre-core` (not a plugin).

## Spaces (organizations)

- Multi-tenant workspaces with membership-based access control.
- Create/list via `GET /api/v1/spaces` and `POST /api/v1/spaces`; manage members under `/spaces/:spaceUid/members`.
- The **space "Deployments" tab** is the org-wide board: every service in the space as a Railway-style card (status, domain, last deploy time/trigger) + a live activity feed. Cards deep-link to `/{space}/{repo}?deploys=1&svc=<id>`.

## Repos

- List/create under `GET/POST /api/v1/repos` (scoped to a space) and `GET /spaces/:spaceUid/repos`.
- Sub-resources: `content`, `tree`, `raw`, `commits`, `branches`, `compare`, `transfer`, `files` (flat file list), `archive/{ref}.zip|.tar.gz`, `star` (PUT/DELETE).
- Repo payloads include `stars`, `starred` (for the viewer) and `require_checks`. In the UI, `t` opens a fuzzy file finder.
- A repo's UI lives under `/{space}/{repo}`. A compact repository header sits above the tab navigation. Code shows an expandable file tree and deployments immediately. The account-saved Layout selector offers Split view (default: preview below), Three columns, Preview left, and Stacked. Three columns uses horizontal workspace scrolling when needed rather than reverting to another layout. Layout changes preserve folder expansion and editing state.

## Pull requests

- `GET/POST /repos/:space/:repo/+/pullreq`, `.../pullreq/:number`, `.../pullreq/:number/diff`.
- Create between branches; view per-file unified diffs; merge (`--no-ff`) or squash.
- `GET .../pullreq/:number/checks` returns the commit statuses of the PR head. With the repo setting `require_checks` (Settings → Actions, or `PATCH /repos/:space/:repo/+ {require_checks: true}`), merge returns `409 {code: 'checks_required'}` until every status is green and at least one exists.
- A merged PR is final: `POST .../pullreq/:number/state` only toggles open and closed.

## Actions (CI/CD)

- Workflows: `.nixre/workflows/*.yml`, falling back to `.gitea/workflows` then `.github/workflows` (first directory with any YAML wins). Triggers `push` (branches/tags/paths), `pull_request` (opened/synchronize/reopened, base-branch filter), `schedule` (UTC cron on the default branch), `workflow_dispatch` (inputs).
- The runner is inside nixre-core. Each job is a throwaway container (default image `NIXRE_ACTIONS_DEFAULT_IMAGE`, `node:22-bookworm`) on `NIXRE_ACTIONS_NETWORK` (default: the apps network), with a real git checkout at `/workspace`. `NIXRE_ACTIONS_CONCURRENCY` jobs run at once.
- Only `run:` steps plus `actions/checkout` (no-op) and `nixre/deploy@v1` (`with: service: <name>`, releases a deploy service at the run commit). Other `uses:` and `services:` fail the workflow with a clear error.
- Secrets: `PUT /repos/:space/:repo/+/actions/secrets/:NAME {value}`, encrypted, masked as `***` in logs, used as `${{ secrets.NAME }}`.
- Runs: `GET .../actions/runs`, `.../actions/runs/:n`, `.../jobs/:id/log`, SSE `.../events`; `POST .../cancel`, `.../rerun`, `POST .../actions/dispatch {workflow, ref, inputs}`. Badge: `GET .../actions/badge.svg?workflow=ci.yml&branch=main`.
- External CI reports with `POST /repos/:space/:repo/+/statuses/:sha {state, context, description, target_url}` (PAT with write access).
- A nixre-core restart fails unfinished runs ("Interrupted by a restart") and removes leftover `nixre.actions=true` containers. Job containers are named `nixre-ci-r<run>-j<job>`.
- The post-receive hook reports tag pushes too (Actions only; webhooks and auto-deploy stay branch-only) and sends the real pusher (`REMOTE_USER` over HTTPS, `NIXRE_PUSHER` over SSH).
- Full reference: `docs/actions.md`.

## Webhooks

- Create `POST /repos/:space/:repo/+/webhooks` with `{url, events}`. The response contains the signing secret (shown once).
- Events (`push`, `pull_request`) deliver to `url` with:
  - `X-Nixre-Event` header
  - `X-Nixre-Signature: sha256=<HMAC-SHA256 of raw body, keyed by secret>`
- Retries with backoff up to 5 attempts. Inspect `GET .../webhooks/<id>/deliveries`.

## Internal endpoints (SSH/SSE plumbing)

- `POST /internal/push-event` — called by the SSH-side post-receive hook (internal token) to trigger auto-deploys.
- `GET /internal/keys/all`, `GET /internal/access/:uid/:space/:repo` — used by `nixre-ssh`.

## API surface quick reference

`/api/v1`: `login` `register` `logout` `user` `admin/registration` `admin/users` `webauthn/login` `passkeys` `user/publickeys` `user/tokens` `user/memberships` `spaces` `spaces/:uid/{members,repos,contributions}` `repos` (+ content/tree/raw/commits/branches/pullreq sub-resources) `prefs` `conversations` `ai/*` `deployments/*`, plus `/git/{space}/{repo}.git` Smart HTTP.

> **Param-naming pitfall:** many service-scoped helpers read `req.params.id` but older routes named the param `:serviceId`. When a whole endpoint 500s, check that the route param name and the helper's read match (a recent bug crashed every `/deployments/services/:id/*` route this way).
