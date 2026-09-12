# Deployments - repo and standalone Docker services

Run a hosted-repo Docker build, public external HTTPS Git source, or container
image as a service. Standalone services belong to a space without creating a
forge repo. **You bring the Dockerfile** for Git; Nixre does not invent a build.
Repo services retain multiple services per repo and existing routes.

## Where they live in the UI

The space **Deployments** tab has a searchable service list, status/access
summary, recent activity, and **New service**. Standalone details open at
`/{space}?tab=deployments&service={id}` with Overview, Deployments, Runtime logs,
Environment, and Settings. Repo entries open
`/{space}/{repo}?deploys=1&svc={id}` instead.

Existing repo Code-view deployment workspaces and Layout preferences remain:
Split view, Three columns, Preview left, or Stacked. Repo `?deploys=1`, legacy
`?tab=deployments`, and service `?dtab=` links continue to work.

## Guided standalone creation

1. **Source:** choose External Git, Container image, llama.cpp, or PostgreSQL.
   For Git, enter a public HTTPS URL and branch/full ref or GitHub PR number.
2. **Configure:** set name, limits, explicit build/runtime settings, and access.
   Generic Git/image services offer env text and an optional managed volume.
3. **Review:** inspect source, mounts, and runtime, then **Create and deploy**.
   Creation stores config; a separate deploy request starts fetch/build/pull.
   The Git ref and Dockerfile are checked during build, not resolved in advance.
   If deployment submission fails after creation, open/retry the existing service.

### External Git and images

- Git API fields: `source_type: "git"`, `git_url`, explicit `branch`, `root_dir`,
  `dockerfile_path` relative to that root, optional `build_target`. No external
  Dockerfile detection: the helper checks a regular file in the resolved tree.
- Branch short names mean `refs/heads/...`; tags need full `refs/tags/v1.2.3`,
  PRs need `refs/pull/123/head`. `HEAD` and full commit SHAs fetchable from the
  remote work too. `ref` and `branch` must agree if both are sent; deploy can
  take a one-run `ref` override. History records the resolved SHA after build.
- Public HTTPS on port 443 only. `github.com` is always allowed;
  `NIXRE_DEPLOY_GIT_HOSTS` adds comma-separated exact DNS hostnames, not URLs,
  ports, wildcards, or IPs. No credential URLs, redirects, SSH, private-repo
  credentials, submodule fetches, or LFS content fetches. The helper does not
  borrow the assistant's GitHub PAT or forge credentials/configuration.
- DNS must resolve exclusively to public IPs and Git is pinned to a checked
  address with TLS verification. Git **2.37+** is required; the core image
  installs distribution-maintained Git. External builds require a **Linux
  amd64/arm64 Docker daemon**; build architecture arguments come from the daemon.
- At most **two source leases per core process**, held until cleanup. Busy
  acquisition is rejected. Acquisition/archive deadline: **120 seconds**;
  temporary-file and archive-output limits: **1 GiB** each. Temp size is polled
  every 250 ms, not a hard disk quota, so transient overshoot is possible.
- Image services use `source_type: "image"`, `image_ref` (tag/digest), and no
  Git fields. A new deploy pulls and pins the resolved image ID to a Nixre-owned
  release tag; launch/restart does not use a mutable shared registry tag.
  Registry credentials are not part of this API. There are no automatic external
  source updates; standalone `auto_deploy` must be false.

### llama.cpp and GPU access

The preset is editable Git config, not a model manager. It starts at
`https://github.com/ggml-org/llama.cpp`, branch `master`, root `.`, Dockerfile
`.devops/cpu.Dockerfile`, target `server`, and entrypoint `/app/llama-server`.
NVIDIA mode suggests `.devops/cuda.Dockerfile`. Review these against the selected
ref. Defaults include HTTP `/health`, 300000 ms startup budget, 2 CPU cores, and
8192 MB; allow memory for the model, context, and runtime overhead.

An **instance admin types an existing absolute Linux host GGUF file path** under
`NIXRE_DEPLOY_BIND_ALLOWLIST`. The preset mounts it read-only at
`/models/model.gguf`. There is **no filesystem picker**, browser upload, model
download, or host-file existence verification. It refers to the Docker host's
filesystem, not the browser's. An empty allowlist disables this preset's mounts.

`runtime_options.host_config.gpus: "all"` requests all NVIDIA GPUs and requires
instance-admin permission plus an already working host NVIDIA driver/runtime and
NVIDIA Container Toolkit. The capability flag means permission, not detected
hardware; no hardware auto-detection or automatic CPU fallback exists. CPU mode
still needs admin permission for the GGUF bind. Ordinary writers can use generic
Git/image setup without host options; untrusted Dockerfiles/images remain unsafe.

### PostgreSQL and retained volumes

Use `source_type: "image"`, `template: "postgres"`, and exactly `postgres:16` or
`postgres:17` (UI default 17). Database/user default to `app`; the server generates
the password and encrypts the initialization env values. **Reveal connection** or
**Copy connection URI** requests plaintext only with writer permission. The URI
includes the password; do not put it in logs, docs, or public client code.

The template fixes internal TCP **5432**, Docker `pg_isready` health, recreate
releases, server-managed runtime permissions, and volume
**`nixre-service-{id}-data`** at **`/var/lib/postgresql/data`**. Generic Git/image
services can also request one managed volume via `volume_path` at creation.
Mount paths are immutable and volume ownership labels are checked on launch.

Stop/delete retain volumes. They grow on host disk with **no quotas or automatic
backups**; retention is not a backup. Deleting a service removes metadata and
credentials, and recreating its name does not reattach the old ID-based volume.
Record the volume identity and arrange backup/restore before deletion. Do not
assume a forge database backup covers application database volumes.

Postgres image/major, initialization database/user, `POSTGRES_*` and `PGDATA`,
runtime/security policy, port, exposure, strategy, and storage are locked against
PATCH/env changes. Full env replacement preserves managed initialization values.
SQL credential rotation is a separate operator task; initialization env changes
would not change an existing database password. Upgrades require a new service
plus explicit migration/restore. **Image rollback is not DB rollback**: rollback
and historical redeploy are rejected for templates and managed-volume services.
Current-image Apply remains available for resource-limit changes.

## Existing repo creation

Open repo Deployments / **New service**, choose the root and **Detect Dockerfiles**,
then set branch, port, limits, and env. **Duplicate...** still copies config and
decrypted secrets into the repo wizard. Repo creation/env editors retain their
`.env` text modes. Push automation is repo-only.

## The service model

Each `deploy_services` row carries space/source ownership, build or image config,
port/limits, desired state, exposure, strategy, and optional volume path. Repo
names remain unique per repo; standalone names are unique among standalone
services in the space. Standalone names are lowercase DNS labels, at most 40
characters, with no leading/trailing hyphen.

- **Env vars** live in `service_env_vars` keyed by `service_id`, **AES-256-GCM encrypted** (`decryptSecret`). The env tab shows them; values are **masked by default** — use the eye to reveal, or Edit to change, then Done re-masks.
- **Secrets stay on the server.** The "Save changes" path does a **PATCH partial merge** (KEY→value upserts, KEY→null deletes, absent keys untouched) so masked values never round-trip through the browser. The create/put path does a full replace.

## Deploys and recovery

- **Standalone always uses recreate** with downtime and stable apps-network
  alias `nixre-svc-{id}`. After build/pull, the engine records stopped intent,
  clears the current release pointer, and stops the old container before launch.
- Fetch/build/pull failure before cutover preserves an existing running release.
  Failure/cancellation/interruption after cutover leaves the service stopped
  pending explicit recovery, also on reboot. Inspect logs and data, then request
  a new deploy. Start cannot recover without a safe current release. Never
  silently start an older image against data the failed candidate may have changed.
- **Repo blue/green persists**: watched-branch pushes deploy when enabled; a new
  candidate must pass health checks before proxy traffic switches. The legacy
  automatic fallback keeps the previous release serving if the candidate fails.
  There is no stable alias for blue/green services. This fallback does not apply
  to standalone recreate releases.
- **Save settings / Apply runtime** re-releases the current healthy stored image
  with current runtime/env/limits. **Rebuild and deploy** (Git) / **Deploy image**
  actually fetches/builds or pulls the configured source. Source edits require
  a new deploy, not just Apply. Start/boot uses stored images, respecting stopped
  intent, rather than fetching upstream updates. Stateless historical rollback
  reuses an image with current runtime config, not historical env/data.

## API and runtime options

Canonical base: **`/api/v1/spaces/{space}/deployments/services`**. GET lists
visible services; POST creates standalone config, not a deployment. Existing
`/api/v1/repos/{space}/{repo}/+/deployments/services` and suffixes remain for repo
services. Standalone reads and all writes require membership or instance admin;
public-space visibility alone does not expose standalone config/activity. Repo
reads retain repo visibility. Authenticate every API request.

| Suffix on service base | Method and purpose |
|---|---|
| `/{id}` | GET/PATCH/DELETE config; PATCH desired_state for Start/Stop |
| `/{id}/deploy` | POST new build/pull, optional Git `{ "ref": "..." }` |
| `/{id}/deployments` and `/{id}/deployments/{depId}` | GET history/details/build log |
| `/{id}/deployments/{depId}/redeploy` | POST healthy stored image with current runtime config |
| `/{id}/deployments/{depId}/rollback` | POST historical image for eligible stateless services |
| `/{id}/deployments/{depId}/cancel` | POST cancellation; `latest` sentinel works here only |
| `/{id}/deployments/{depId}` | DELETE non-current release |
| `/{id}/env`, `/{id}/env/{key}`, `/{id}/env/{key}/reveal` | GET keys/PUT replacement, DELETE key, GET writer-only reveal |
| `/{id}/events`, `/{id}/runtime-logs`, `/{id}/http-logs`, `/{id}/stats`, `/{id}/uptime` | GET observability; runtime logs require writer access |
| `/{id}/domains` | GET/POST domains, with existing verify/DNS/delete child suffixes |

Runtime options support `health_type` (`http`, `tcp`, or `docker`), optional
Docker `health_command`, `health_path`, startup timeout (1000-600000 ms), and
command/entrypoint arrays. HTTP accepts responses below 500; TCP needs a connection;
Docker requires running/healthy status, not just a running container. Host config
fields are admin-only, even if explicitly empty; binds also need the allowlist.
Standalone `network_mode` overrides and template runtime edits are rejected.
See `docs/deployments-runtime.md` for the full schema and safety policy.

Redeploy reuses a selected release image when its status is `live`; non-live
records retry the build/pull pipeline. Apply runtime selects the current release.
Stateful historical redeploy remains rejected, not a recovery shortcut.

## Domains & routing

Apps use an approved **shared apps network, NOT per-space isolation**. Internal
exposure (standalone default) disables all edge routes, automatic base-domain
addresses, and custom domains, with **no public TCP proxy**. Other deployed apps
can still reach `nixre-svc-{id}:{port}`; use app/database authentication. The forge
database is isolated on its separate data network; template databases are app
services, not forge storage.

App containers are not port-published. HTTP exposure uses the central **deploy
proxy on port 3003**, routing by **Host header**. Standalone domain controls are
in Settings; repo Domains tabs remain. Route the intended HTTP edge to 3003:

- **Cloudflare Tunnel:** forward intended app hostnames to `http://localhost:3003`. Admins may use the configured Cloudflare token for automatic CNAME provisioning; other users must publish TXT proof and configure DNS themselves. Conflicting records are never overwritten. The UI shows DNS status and manual guidance.
- **Host Caddy/Nginx:** add an A record then a host block `reverse_proxy 127.0.0.1:3003` (TLS at the edge). The UI generates the exact DNS table + snippet.

Custom domains require TXT ownership proof or admin approval. Cloudflare
automation is admin-only and never overwrites conflicting records. Reserved
hostnames apply to all route types; `DEPLOY_BASE_DOMAIN` supplies automatic app
addresses and its namespace cannot be claimed as a custom domain.

## Security upgrades

Follow `docs/security-upgrade.md` before changing keys or networks. Boot converts
legacy encrypted values transactionally; keep the old key until verification.
Existing apps are reconnected without deleting volumes. Existing services retain
capability policy 1; new services default to policy 2. Admins may explicitly PATCH
`security_policy_version` on non-template services and redeploy after testing
image requirements. The Postgres template's policy/runtime is locked. Outdated
agent sandboxes are replaced while retaining their named workspace volumes.

### TLS depth gate

Universal SSL free covers the apex plus **one** level of subdomain (`<your-domain>` + `*.<your-domain>`). A multi-level name (a **dot inside a label** e.g. `a.b.<your-domain>`) fails TLS. The UI gates these behind a confirmation:

- `POST .../domains` returns `409 TLS_DEPTH_CONFIRMATION` (with `code`/`depth`/`zone`) when depth > 1 unless body has `confirm: true`.
- The UI shows an amber confirmation panel; a "TLS likely broken" badge appears on such cards, and `tls_risk_domains` are surfaced on the org board.
- **Prefer hyphenated labels** (`foo-bar.<your-domain>`), never dots.

## Observability defaults

- **HTTP logs**: method/path/status/duration; failures ≥ `preserve_status_min` (400) kept 7 days, others 24h — per-service tunable. Filter chips drive query params.
- **Resources**: hard caps via container `NanoCpus`/`Memory`; live CPU % of limit + working-set memory bars sample `docker stats` every ~10s.
- **Uptime**: HTTP/TCP/Docker checks sample running services about every 30s;
  the space list and activity feed show authorized services, and the dashboard
  retains a fleet overview. Internal services have no proxy HTTP request history.
- **Logs**: build/status events use SSE. Standalone Runtime logs is a
  writer-authorized container-output snapshot; Refresh fetches new output.

## Config knobs

| Env | Default | Purpose |
|---|---|---|
| `DEPLOY_PROXY_PORT` | `3003` | central app-traffic listener (`0` disables) |
| `DEPLOY_PROXY_BIND` | `127.0.0.1` | publish binding |
| `DEPLOY_HEALTH_TIMEOUT_MS` | `30000` | max wait for a release to answer |
| `DEPLOY_PROBE_MS` / `DEPLOY_METRICS_MS` / `DEPLOY_SWEEP_MS` | `30s`/`10s`/`60s` | probe / stats / reconcile sweeps |
| `NIXRE_DEPLOY_GIT_HOSTS` | empty | extra exact public Git hosts alongside github.com |
| `NIXRE_DEPLOY_BIND_ALLOWLIST` | empty | approved host bind prefixes; instance-admin access still required |

## Env var rules (UI + backend enforced)

Valid names `[A-Za-z_][A-Za-z0-9_]*`, no duplicates, at most 100 vars. `.env` text
accepts `KEY=value`, optional `export`, quotes, comments, and blank lines. PATCH
`/{id}` with `env` merges explicit string values (`null` deletes); PUT `/{id}/env`
with `vars` replaces custom vars, preserving Postgres initialization values.
Save then Apply runtime to use env changes with the current image.

## Publishing an upgrade

Rebuild/restart core: `docker compose up -d --build nixre-core`. Migration
`028_standalone_deployments.sql` applies on boot, preserving repo service IDs and
env data while adding space/source/storage fields and release snapshots. Build
with `npm run build` from `ui/` and publish `ui/dist` through the configured Caddy
setup; `ui/public/llms.txt` is copied into that build. Source-only edits are not a
rollout. Follow `docs/security-upgrade.md`, check `/healthz`, and test the relevant
service flows after publication. These docs do not prove a live deployment works.
