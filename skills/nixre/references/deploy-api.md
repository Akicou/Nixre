# Deployment API — the whole lifecycle without a browser

Everything the Deployments UI does is a JSON API call, so an agent holding a
personal access token can create a service, deploy it, and read why a deploy
failed. Nothing here needs the web console.

```bash
BASE=https://git.<your-domain>/api/v1
TOKEN=<personal access token>          # Settings -> Access Tokens
SVC="$BASE/repos/<space>/<repo>/+/deployments"

curl -s -H "Authorization: Bearer $TOKEN" "$SVC/services"
```

Auth is `Authorization: Bearer <token>` on every call (a session token works
too). Errors are always `{"message": "..."}` with a meaningful status; a few add
a `code` (e.g. `TLS_DEPTH_CONFIRMATION`, `DOMAIN_VERIFICATION_FAILED`).

Note the literal `+` segment in the path — it separates the repo from its
sub-resources. Do not URL-encode it.

## Who may call what

| Level | Who | What it covers |
|---|---|---|
| **read** | anyone who can read the repo (public repo = anyone, private = space member) | listing services, deployment status, domains, stats, uptime, HTTP logs, SSE events, env var **names** |
| **write** | member of the owning space, or instance admin | create/patch/delete a service, set env vars, deploy, redeploy, roll back, cancel, attach domains, **read build and container logs** |
| **admin** | instance admin only | `host_config` runtime options (bind mounts, caps, devices, privileged, host network), `security_policy_version`, Cloudflare DNS automation, forcing domain verification |

A repo you cannot read answers **404**, never 403 — a 403 would confirm that a
private repo of that name exists. Write access you lack answers **403**.

## 1. Create a service

`POST {SVC}/services` — write access.

```json
{
  "name": "web",
  "branch": "main",
  "root_dir": "apps/web",
  "dockerfile_path": "Dockerfile",
  "container_port": 8080,
  "auto_deploy": true,
  "cpu_cores": 1,
  "memory_mb": 512,
  "env": { "NODE_ENV": "production" },
  "runtime_options": { "health_path": "/healthz" }
}
```

- `name` is slugified to a DNS label and is unique per repo (`409` on collision).
- `root_dir` is the build context, repo-relative. `..` is rejected.
- `dockerfile_path` is relative to `root_dir` and **must actually exist** on the
  ref — the platform never guesses. A wrong path returns `400` listing the
  Dockerfiles it did find. To look first:
  `GET {SVC}/dockerfiles?ref=main&root_dir=apps/web`.
- `container_port` is the port your app listens on **inside** the container.
  Containers are never port-published; the deploy proxy reaches them over the
  internal docker network.
- `cpu_cores` / `memory_mb` become hard container caps.
- At most **20 services per repo** (`DEPLOY_MAX_SERVICES_PER_REPO`), `409` beyond.
- `security_policy_version` is rejected here on purpose; new services always get
  the current policy.

Returns `201` with the service, including its numeric `id` — every later call
needs it. `PATCH {SVC}/services/{id}` changes any of the same fields;
`DELETE {SVC}/services/{id}` stops the container and removes the service and its
history.

### Health probe

A release only gets traffic after the new container answers an HTTP request.
Set the path with `runtime_options.health_path` (default `/`) and the budget with
`runtime_options.health_timeout_ms` (1000–600000, default
`DEPLOY_HEALTH_TIMEOUT_MS`). **If your app has no route at `/`, set this** — the
most common first-deploy failure is a healthy app failing a probe on a path that
404s… which is fine (any HTTP answer counts), versus an app bound to
`127.0.0.1` instead of `0.0.0.0`, which never answers at all.

### Persistent directories / bind mounts

`runtime_options.host_config.binds` takes `/host/path:/container/path[:ro|rw]`
entries, but it is **fail-closed and admin-only**: the host path must be on the
instance allowlist (`NIXRE_DEPLOY_BIND_ALLOWLIST`) *and* the caller must be an
instance admin. Without both you get `400` explaining which gate refused. Same
for `privileged`, `cap_add`/`cap_drop`, `devices`, `group_add`, `extra_hosts`,
`tmpfs`, `shm_size` and `network_mode: host`. Unknown fields are rejected rather
than ignored, so a typo fails loudly instead of silently doing nothing.

If you are not an admin, design for a stateless container and keep state in a
database service.

## 2. Environment variables

| Call | Effect |
|---|---|
| `GET {SVC}/services/{id}/env` | **names and timestamps only** — values are never in this response |
| `PUT {SVC}/services/{id}/env` `{"vars":{...}}` | full replace, transactional |
| `PATCH {SVC}/services/{id}` `{"env":{"K":"v","OLD":null}}` | partial merge: upsert `K`, delete `OLD`, leave everything else alone |
| `DELETE {SVC}/services/{id}/env/{KEY}` | remove one key |

Values are stored AES-256-GCM encrypted. Prefer the PATCH merge: it means you
never have to know (or replay) the values of secrets you are not changing.
Names must match `[A-Za-z_][A-Za-z0-9_]*`, max 100 per service. **Env changes
apply on the next deploy, not immediately** — set them, then deploy.

## 3. Deploy

```
POST {SVC}/services/{id}/deploy            {"ref": "main"}   -> 202
POST {SVC}/services/{id}/deployments/{depId}/redeploy         -> 202
POST {SVC}/services/{id}/deployments/{depId}/rollback         -> 202
POST {SVC}/services/{id}/deployments/{depId}/cancel           -> 200
DELETE {SVC}/services/{id}/deployments/{depId}
PATCH  {SVC}/services/{id}  {"desired_state": "stopped"}      # stop / "running" to start
```

`202` means *accepted* — the build runs in the background. `ref` may be a
branch, tag or sha; it defaults to the service's branch. Pushing to the watched
branch also deploys when `auto_deploy` is on.

Rollback re-releases a previous deployment's **stored image** with no rebuild, so
it is the fast way back. Redeploy rebuilds from that deployment's commit.

Anywhere a `{depId}` appears you may write **`latest`** (most recent deployment)
or **`failed`** (most recent failed one) instead of a number, so you do not need
a list call first.

## 4. Watch it, then read the failure

```
GET {SVC}/services/{id}/deployments?limit=30       # history + status
GET {SVC}/services/{id}/deployments/latest         # one, resolved
GET {SVC}/services/{id}/events                     # SSE: live build lines, status changes
```

Status goes `queued` → `building` → `releasing` → `live`, or ends at `failed` /
`cancelled`. A deployment that was replaced by a newer one is `superseded`.
`serving: true` marks the one actually taking traffic. Poll the history, or
consume the SSE stream if you can hold a connection open.

### The failed-build log

**This is the call to make when a deploy fails.** Write access required.

```
GET {SVC}/services/{id}/deployments/failed/log
GET {SVC}/services/{id}/deployments/42/log?tail=100
GET {SVC}/services/{id}/deployments/failed/log?stream=all&format=json
```

| Param | Values | Meaning |
|---|---|---|
| `stream` | `build` (default), `runtime`, `all` | which log |
| `tail` | 1–20000 | last N lines only |
| `format` | text (default), `json` | plain text is grep-friendly; JSON adds status/error/sha |

Two logs exist and they answer different questions:

- **`build`** — the `docker build` output. This is where a failing
  `npm ci`, a missing file, or a bad base image shows up.
- **`runtime`** — the container's own stdout/stderr, captured *before* the failed
  container was removed. This is where an app that built fine but crashed or
  never listened tells you why (missing env var, failed migration, bound to the
  wrong address).

So: build log empty but there is an error about a health check → read
`stream=runtime`. Build log full of compiler output → the answer is at its end,
use `tail`.

For the container that is **running right now** (not a failed one):

```
GET {SVC}/services/{id}/logs?tail=200          # plain text
GET {SVC}/services/{id}/logs?format=json
GET {SVC}/services/{id}/logs?deployment_id=41  # a specific still-present container
```

`409` from that endpoint means there is no running release to read — look at the
deployment history instead. `503` means docker is unreachable on the host.

The deployment detail response also carries the logs (`build_log`,
`runtime_log`), but only for callers with write access: build output routinely
echoes secrets. A reader sees `logs_readable: false`, empty bodies, and
`has_build_log` / `has_runtime_log` flags so it at least knows they exist.

## 5. Make it reachable

```
GET    {SVC}/services/{id}/domains
POST   {SVC}/services/{id}/domains        {"domain":"app.example.com","kind":"tunnel"|"caddy"}
POST   {SVC}/services/{id}/domains/{domainId}/verify
DELETE {SVC}/services/{id}/domains/{domainId}
```

An attached domain is **not routed until it is verified** — publish the TXT
record the create/list response hands you, then call `verify`. Admins on a
Cloudflare-configured instance get the CNAME created for them and the domain
verified in the same call. The response always includes `guidance` with the
exact DNS rows plus ready-made Caddy/Nginx snippets, so you can hand a human the
one step you cannot do yourself.

Reserved hostnames (the forge's own, and the app base domain's namespace) are
refused with `409`.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `400` "Dockerfile … not found" on create | `dockerfile_path` is relative to `root_dir`, not the repo root | call `GET {SVC}/dockerfiles?root_dir=…` and copy a `file` value verbatim |
| Deploy fails, "app did not answer on port N within Ns" | app listens on `127.0.0.1`, or on a different port, or is still starting | bind `0.0.0.0`; check `container_port`; raise `runtime_options.health_timeout_ms`; read `?stream=runtime` |
| Build log looks fine, deploy still failed | release/health stage, not the build | `?stream=runtime` — the crash is there |
| App deployed but URL 404s or times out | domain attached but unverified, so it is not routed | `GET …/domains`, publish the TXT record, `POST …/verify` |
| Env var change had no effect | env applies at release time | deploy again |
| `400` about `host_config` | bind mounts / caps are admin + allowlist gated | run stateless, or ask an instance admin |
| `409` "at most 20 …" | per-repo service cap / per-service domain cap | delete what you no longer need |
| `503` "Docker is not available" | the host's docker socket is unreachable | an operator problem, not an input problem |
| Deploy returned `202` but nothing happened | `202` is *accepted*; the build is async | poll `…/deployments/latest` |

## What the API does not do

- **No replicas.** One container serves a service; releases are blue/green
  (new container must pass its probe before the old one is retired). There is no
  `replicas` field — horizontal scaling is not implemented.
- **No volume management.** Persistence is host bind mounts only, admin-gated
  (above). There is no create-a-volume call.
- **No log following on the plain-text endpoints.** They return a tail and
  close. Use the SSE `events` stream for live build output.
