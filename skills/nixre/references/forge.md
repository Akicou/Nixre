# Repos, spaces, pull requests, webhooks

Everything here is first-class in `nixre-core` (not a plugin).

## Spaces (organizations)

- Multi-tenant workspaces with membership-based access control.
- Create/list via `GET /api/v1/spaces` and `POST /api/v1/spaces`; manage members under `/spaces/:spaceUid/members`.
- The **space "Deployments" tab** is the org-wide board: every service in the space as a Railway-style card (status, domain, last deploy time/trigger) + a live activity feed. Cards deep-link to `/{space}/{repo}?deploys=1&svc=<id>`.

## Repos

- List/create under `GET/POST /api/v1/repos` (scoped to a space) and `GET /spaces/:spaceUid/repos`.
- Sub-resources: `content`, `tree`, `raw`, `commits`, `branches`, `compare`, `transfer`.
- A repo's UI lives under `/{space}/{repo}`. Repo layout mirrors the profile layout: top tab nav + a 296px sidebar (space avatar, repo name, badges, description, clone button, meta rows).

## Pull requests

- `GET/POST /repos/:space/:repo/+/pullreq`, `.../pullreq/:number`, `.../pullreq/:number/diff`.
- Create between branches; view per-file unified diffs; merge (`--no-ff`) or squash.

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
