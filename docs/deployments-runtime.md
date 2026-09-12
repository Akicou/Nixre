# Deployment services and runtime options

## Standalone services

The space's **Deployments** tab lists hosted-repo and standalone services, with
search, status, access mode, and recent activity. **New service** opens a
three-step **Source / Configure / Review** setup for **External Git**,
**Container image**, **llama.cpp**, or **PostgreSQL**. No Nixre repository is
created for a standalone service. Existing repo Code-view deployments, creation
forms, and repo-scoped API routes remain available.

Standalone details open at `/{space}?tab=deployments&service={id}` and provide
Overview, Deployments, Runtime logs, Environment, and Settings. Repo services
still open at `/{space}/{repo}?deploys=1&svc={id}`. Runtime logs are refreshable
container-output snapshots; the events API carries live status/build events.

### External Git

Set `source_type: "git"`, `git_url`, an explicit `branch`/ref, `root_dir`,
`dockerfile_path`, and optional `build_target`. The Dockerfile path is relative
to the selected build root, not necessarily the repository root. Nixre does not
invent a Dockerfile or detect one for external sources. Creation stores config;
the build resolves the ref and checks that the root is a tree and the Dockerfile
is a regular file, not a symlink or submodule. Deployment history records the
resolved commit. The review step does not resolve a commit in advance.

- Use a branch such as `main` or `refs/heads/main`, `refs/pull/123/head` for a
  GitHub pull request, `refs/tags/v1.2.3` for a tag, or a full commit SHA the
  remote permits fetching. Short names mean branches, not tags. `HEAD` is also
  supported. The API's `ref` alias and `branch` must agree if both are supplied;
  `POST .../{id}/deploy` accepts an optional one-run `ref` override.
- Only public HTTPS repositories on port 443 are supported. `github.com` is
  always allowed; `NIXRE_DEPLOY_GIT_HOSTS` adds comma-separated exact DNS
  hostnames, not URLs, ports, IP literals, or wildcards.
- Credential-bearing URLs, query strings, fragments, URL escapes, redirects,
  SSH, and private repositories are not supported. The helper does not use the
  user's GitHub PAT, forge credentials, credential helpers, or inherited Git
  configuration. Submodules and Git LFS content are not fetched.
- DNS must resolve exclusively to public addresses. Git is pinned to a checked
  address with TLS verification enabled, rather than resolving the host again
  during fetch. Git **2.37+** is required for `http.curloptResolve`; the core
  container installs distribution-maintained Git. Older Git fails closed.
- At most **two source leases per core process** are active, including while
  their build contexts are held. A busy helper rejects new acquisition rather
  than queuing it. Acquisition and archive streaming have a **120-second**
  deadline. Temporary files and archive output are limited to **1 GiB** each;
  temporary-file size is polled (250 ms), not a filesystem quota, so transient
  overshoot is possible. Cleanup releases the lease and temporary repository.
- External builds require a **Linux Docker daemon reporting amd64 or arm64**.
  Nixre passes daemon-derived `TARGETARCH` and `TARGETPLATFORM` build arguments;
  this is not a cross-compilation or automatic GPU-detection feature.

These fetch safeguards do not make an untrusted Dockerfile safe to execute.
Only deploy code and images you trust on the deployment host. External services
have `auto_deploy: false`: there is no external push hook, polling update, or
automatic image-tag refresh.

### Container images and llama.cpp

Image services use `source_type: "image"` and `image_ref` (tag or digest), with
no Git fields or Git ref on deploy. A new image deployment pulls the configured
reference and tags its resolved image ID with a Nixre-owned release tag. Runtime
launches and restart recovery use that release image, not a mutable shared
registry tag. Registry credentials are not part of this API.

The llama.cpp preset is an editable external-Git configuration, not a separate
backend source type. It starts with `https://github.com/ggml-org/llama.cpp`,
`master`, root `.`, `.devops/cpu.Dockerfile`, and build target `server`. NVIDIA
mode switches the suggested Dockerfile to `.devops/cuda.Dockerfile`. Check these
paths and the `/app/llama-server` entrypoint against the ref you select.

An **instance admin types an existing absolute Linux deployment-host GGUF file
path** under `NIXRE_DEPLOY_BIND_ALLOWLIST`, for example `/srv/models/model.gguf`.
There is no filesystem picker, browser upload, model downloader, or host-file
existence check in the wizard. The preset mounts the file as
`/srv/models/model.gguf:/models/model.gguf:ro` and supplies model, listen host,
port, context, and GPU-layer arguments. It defaults to HTTP `/health`, a
300000 ms startup budget, 2 CPU cores, and 8192 MB RAM; size resources for the
actual model and context rather than treating these defaults as a guarantee.

`runtime_options.host_config.gpus: "all"` requests all NVIDIA GPUs through
Docker DeviceRequests. It requires instance-admin permission and an
operator-installed NVIDIA driver/runtime and NVIDIA Container Toolkit on the
Docker host. The capability flag reports permission only: hardware is not
detected or verified, and there is no automatic CPU fallback. CPU mode still
requires admin approval for the model bind mount.

### PostgreSQL and managed storage

The PostgreSQL template accepts `source_type: "image"`, `template: "postgres"`,
and exactly `image_ref: "postgres:16"` or `"postgres:17"` (the UI defaults to
17). Optional `database` and `username` default to `app`. The server generates
the password and stores all initialization variables encrypted. Listing env
vars returns names/timestamps only; **Reveal connection** and **Copy connection
URI** fetch secrets only through writer-authorized reveal requests. The URI
contains the password and must be treated as a secret.

The template fixes internal TCP port **5432**, recreate releases, a Docker
`pg_isready` health check, server-managed runtime permissions, and a managed
volume named **`nixre-service-{id}-data`** mounted at
**`/var/lib/postgresql/data`**. Other Git/image services can request a single
managed volume by setting `volume_path` at creation; its mount path is immutable.
Nixre creates/checks ownership labels on the volume rather than accepting an
arbitrary existing volume name.

**Stop and service deletion retain the volume.** Deleting a service deletes its
metadata and stored credentials, not its data. Record the volume identity and
arrange a backup/recovery procedure before deletion; creating another service
with the same name does not reattach the old ID-based volume. Storage grows on
host disk, with **no preallocated size, disk quota, or automatic backup**.
Retention is not a backup, and the forge database backup does not back up these
application volumes automatically.

The template's image reference/major, initialization database/user, port,
exposure, volume, strategy, runtime options, and security policy cannot be
changed through PATCH. `POSTGRES_*` and `PGDATA` cannot be supplied, replaced,
or deleted through env edits; full env replacement preserves the three managed
initialization values. SQL credential rotation is a separate operator task:
editing initialization environment variables would not rotate an initialized
database. Plan version changes as a new service plus an explicit backup/restore
or data migration, not a tag edit. **Image rollback is not database rollback**;
rollback and historical redeploy are rejected for template/managed-volume
services. Applying the current healthy image with updated resource limits is
still supported.

## Release and networking semantics

- **All standalone services use `recreate`, never blue/green.** After a build or
  pull succeeds, the engine records stopped intent, clears the current release,
  and stops the old container before launching its replacement. Expect downtime.
  This avoids concurrent volume writers or model servers and provides the stable
  Docker DNS alias **`nixre-svc-{id}`** on the approved apps network.
- A fetch/build/pull failure before cutover leaves a previous running release
  alone. A failure, cancellation, or interruption after recreate cutover begins
  leaves the service stopped pending explicit recovery. The candidate may have
  changed persistent data. Inspect logs and data before requesting a new deploy;
  Start cannot recover a service with no safe current release. Boot reconciliation
  does not silently restore the old image in this state.
- Existing repo services retain their blue/green behavior: a candidate must pass
  health checks before receiving proxy traffic, and a failed candidate leaves the
  previous release serving (the legacy automatic fallback). Blue/green services
  do **not** advertise a stable `nixre-svc-{id}` alias. Do not apply their fallback
  guarantee to a standalone/stateful recreate release.
- **Save settings** and env edits store configuration. **Apply runtime** in
  standalone Settings redeploys the current healthy stored image with current
  runtime settings, limits, and env, without fetching Git or pulling an image.
  **Rebuild and deploy** (Git) / **Deploy image** performs a new fetch/build or
  pull using current source config. Source changes therefore need a new deploy,
  not just Apply. Start/boot recovery also uses stored images, not source updates.
- `exposure: "internal"` is the standalone default. It disables all edge routes,
  including automatic base-domain addresses and attached custom domains; there
  is no public TCP proxy. Other deployed apps can still reach
  `nixre-svc-{id}:{container_port}` on the **shared apps network**. It is **not
  per-space isolation**. Keep application authentication enabled. The forge's
  `nixre-db` is isolated separately on its data network; a template database is
  an app-network service, not the forge database.
- `exposure: "http"` enables the deploy proxy on `:3003`. Automatic addresses
  depend on `DEPLOY_BASE_DOMAIN`; custom domains require ownership verification
  or admin approval. Standalone services cannot override `host_config.network_mode`.

## API and access

The canonical base is **`/api/v1/spaces/{space}/deployments/services`**. It lists
visible repo and standalone services; POST there creates a standalone service.
The existing `/api/v1/repos/{space}/{repo}/+/deployments/services` base and
service suffixes continue to work for repo services. Dockerfile detection
remains repo-only at `.../+/deployments/dockerfiles`.

| Method | Suffix on the service base | Purpose |
|---|---|---|
| GET / POST | (none) | List services / create config (does not deploy) |
| GET / PATCH / DELETE | `/{id}` | Read / update / stop and delete service |
| POST | `/{id}/deploy` | New build or pull; optional Git `{ "ref": "..." }` |
| GET | `/{id}/deployments` or `/{id}/deployments/{depId}` | History / release details and build log |
| POST | `/{id}/deployments/{depId}/redeploy` | Re-release a healthy stored image with current runtime config |
| POST | `/{id}/deployments/{depId}/rollback` | Historical image release for eligible stateless services |
| POST | `/{id}/deployments/{depId}/cancel` | Cancel active work (`latest` is accepted here only) |
| DELETE | `/{id}/deployments/{depId}` | Delete a non-current release record |
| GET / PUT | `/{id}/env` | List keys / replace custom env via `{ "vars": {...} }` |
| GET | `/{id}/env/{key}/reveal` | Writer-authorized plaintext reveal |
| DELETE | `/{id}/env/{key}` | Remove one non-managed variable |
| GET | `/{id}/events`, `/{id}/runtime-logs`, `/{id}/http-logs`, `/{id}/stats`, `/{id}/uptime` | Events, logs, metrics, health |
| GET / POST | `/{id}/domains` | List / attach HTTP domains; existing verify/DNS/delete suffixes persist |

PATCH `/{id}` accepts an `env` partial merge (string upserts, `null` deletes,
absent keys untouched) and `desired_state: "running"` or `"stopped"` for lifecycle
control. All API calls require authentication. Standalone reads/writes and secret
reveal require space membership or instance-admin access; a public space does
not expose standalone config or activity to non-members. Repo service reads
retain repo visibility checks. The space board API
`GET /api/v1/spaces/{space}/deployments` supplies the filtered list, activity,
`can_write`, and permission/policy capabilities, not host hardware discovery.

The redeploy endpoint reuses an image when the selected deployment has status
`live`; a non-live deployment is retried through the build/pull pipeline instead.
The UI's Apply runtime specifically selects the current release. Stateful
historical redeploy is rejected rather than treated as a recovery shortcut.

## Runtime defaults

Every deploy service runs with sane defaults: memory/CPU caps, `unless-stopped`
restart policy, `init`, and an attachment to the approved apps network. Services
with special needs (Docker-outside-of-Docker sandboxes, custom health
endpoints, device access) can override parts of that via **runtime options** —
a JSON blob stored per service and merged into the container create payload at
launch time.

## Where to set them

New services use security policy `2` (drop all capabilities and enable
`no-new-privileges` by default). Migration 026 preserves policy `1` for existing
services so recreation and rollback do not silently break root-started images.
Only an instance admin can PATCH `security_policy_version` to `1` or `2` on a
non-template service. The Postgres template keeps policy 2 and adds a fixed
server-managed capability set needed by its official image entrypoint.
Test the image and explicitly redeploy to apply a policy change; ordinary config
edits and clearing runtime options preserve the selected policy. See
[the upgrade guide](security-upgrade.md) for network and secret migration.

- **Standalone creation**: guided health, command, mount, and resource fields;
  **Settings** has a runtime JSON editor for non-template services.
- **Repo create wizard**: "Show advanced runtime options" (JSON textarea).
- **Repo service detail / Runtime tab**: JSON editor with live summary chips.
- **API**: POST on the service base or PATCH `/{id}` with a `runtime_options`
  object. PATCH with `null` clears to defaults; omitting the key preserves it.
  The Postgres template's runtime is server-managed and cannot be edited.

Options take effect on the **next container launch**. Use Apply runtime for a
current healthy release; recreate still interrupts service. When replacing a
runtime object, omitted fields inside that object use defaults, not a deep merge
with the previous object. Non-admin writers must omit `host_config` fields,
even explicitly empty ones, rather than replaying an admin's normalized config.

## Schema

```jsonc
{
  "version": 1,
  "health_type": "http",            // http (default) | tcp | docker
  "health_command": null,           // Docker CMD/CMD-SHELL array; docker only
  "health_path": "/health",        // release probe + uptime probe path
  "health_timeout_ms": 30000,      // optional per-service health budget
  "command": ["--serve"],          // container Cmd override
  "entrypoint": ["/app/server"],   // container Entrypoint override
  "host_config": {
    "binds": ["/host/path:/container/path:rw"],
    "privileged": false,
    "cap_add": ["NET_ADMIN"],
    "cap_drop": ["CHOWN"],
    "devices": ["/dev/kvm:/dev/kvm:rwm"],
    "gpus": null,                    // "all" for NVIDIA, or null
    "group_add": [998],
    "extra_hosts": ["db:10.0.0.5"],
    "shm_size": 268435456,         // bytes
    "tmpfs": { "/run": "" },
    "network_mode": null           // standalone must keep null; repo overrides below
  }
}
```

Unknown fields are rejected. These runtime fields are optional; defaults apply
to omitted fields. `command` and `entrypoint` are argument arrays, not shell
strings. HTTP checks accept responses below 500 at `health_path` (default `/`);
TCP checks require a successful connection. Docker checks require the container
to be running with Docker health status `healthy`, using an image HEALTHCHECK
or `health_command`, for example `["CMD", "/app/check-health"]`. A missing Docker
health check does not pass. Startup budgets range from 1000 to 600000 ms; without
an override the instance `DEPLOY_HEALTH_TIMEOUT_MS` applies.

## Safety model (fail closed)

Runtime options can grant a container host-level powers, so they are gated:

| Option | Requires |
|---|---|
| `host_config.binds` | instance admin **and** the host path must match `NIXRE_DEPLOY_BIND_ALLOWLIST` |
| `host_config.privileged` | instance admin **and** `NIXRE_DEPLOY_ALLOW_PRIVILEGED=true` |
| `host_config.network_mode: "host"` | repo services only: instance admin **and** `NIXRE_DEPLOY_ALLOW_HOST_NETWORK=true` |
| `host_config.gpus: "all"` | instance admin; host NVIDIA runtime/toolkit must already work |
| other `host_config.*` fields | instance admin |
| `health_type`, `health_command`, `health_path`, `health_timeout_ms`, `command`, `entrypoint` | service writer; Postgres template overrides are locked |

Set the env vars on nixre-core (compose `.env`) and restart core to change
instance policy. An empty allowlist disables bind mounts entirely.
Repo-only network overrides accept `bridge`, `none`, `host`, or
`container:<name>`; standalone services must keep the shared apps attachment.

> **Warning:** bind-mounting `/var/run/docker.sock` gives the container
> effective root control over the host Docker daemon. Only do this for
> trusted services (e.g. a sandbox runner).

## Example: Docker-outside-of-Docker sandbox runner

```json
{
  "health_path": "/health",
  "host_config": {
    "binds": [
      "/var/run/docker.sock:/var/run/docker.sock",
      "/var/lib/nixre-sandbox:/var/lib/nixre-sandbox"
    ],
    "group_add": [998]
  }
}
```

With compose `.env`:

```
NIXRE_DEPLOY_BIND_ALLOWLIST=/var/run/docker.sock,/var/lib/nixre-sandbox
```

The bind-mounted host path must be identical inside the container when the
service spawns *sibling* containers (`docker run -v` resolves against the
**host** filesystem), which is exactly what the sandbox runner needs.

## Related knobs

- `DEPLOY_PROXY_TIMEOUT_MS` (default 120000) — idle timeout for proxied app
  traffic; raise it for streaming AI services that pause between tokens.

## Publishing an upgrade

Backend source is baked into the core image. Rebuild/restart with
`docker compose up -d --build nixre-core`; migration
`028_standalone_deployments.sql` applies on boot, preserving repo service IDs,
repo/name uniqueness, existing routes, and encrypted env rows while adding
space ownership, sources, storage, and release snapshots. Follow
[the security upgrade guide](security-upgrade.md) for existing installations.

Build the UI with `npm run build` from `ui/` and publish the resulting `ui/dist`
through the existing Caddy setup, including the copied `ui/public/llms.txt`.
Updating source alone does not update the served UI. Check core `/healthz` and
exercise the relevant service flow after rollout; this document is not evidence
of a verified live deployment.
