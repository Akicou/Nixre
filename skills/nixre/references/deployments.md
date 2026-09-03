# Deployments — Docker services from repos

Turn any repo subdirectory into a long-running Docker service. **You bring the Dockerfile**; Nixre only detects and builds what you point at. A repo can host **multiple** services (same Dockerfile, different env/ports/branches).

## Where they live in the UI

Deployments are **inside the repo's Code view** — not a standalone page or tab. A collapsible "Deployments" bar sits below the file browser/README. Open it with:

- sidebar row (`Deployments`), or
- deep link `/{space}/{repo}?deploys=1`, or
- legacy `?tab=deployments`.

There is **no standalone deployments route/page/tab**. Sub-tabs inside a service (Overview / Deploys / Env / Domains / Logs) use `?dtab=<tab>` to avoid colliding with the repo view's `?tab=`.

## Creating a service

1. Repo → Deployments → **New service** (or **Duplicate…** to clone an existing service's config **and** its decrypted secrets into the wizard).
2. Pick the **root directory**, **Detect Dockerfiles**, choose one.
3. Set the container **port**, CPU/RAM limits, `auto_deploy`, and env vars.
4. Create. The wizard lets you paste a whole `.env` (serialize rows → editable buffer → validation → merged back).

## The service model

Each `deploy_service` row pins: `name` (UNIQUE per repo), `root_dir`, `dockerfile_path`, `branch`, `container_port`, `cpu_nano_cpus`, `memory_bytes`, `auto_deploy`, `desired_state`. Newer rows also carry CF domain info.

- **Env vars** live in `service_env_vars` keyed by `service_id`, **AES-256-GCM encrypted** (`decryptSecret`). The env tab shows them; values are **masked by default** — use the eye to reveal, or Edit to change, then Done re-masks.
- **Secrets stay on the server.** The "Save changes" path does a **PATCH partial merge** (KEY→value upserts, KEY→null deletes, absent keys untouched) so masked values never round-trip through the browser. The create/put path does a full replace.

## Deploys & releases (blue/green)

- Push to the watched branch auto-deploys if `auto_deploy` is on, or deploy manually at any ref/sha.
- Build stream live over SSE. Releases are blue/green: the new container must answer **health probes** before it gets traffic.
- **A failed build/release never touches the serving container** — traffic stays on the previous healthy release and a red banner warns (`last_failed_deployment_id`). From history: inspect logs, redeploy, roll back to an older healthy release, or delete records.
- On restart (server reboot included), core reconciles and recreates service containers from stored images.

## Domains & routing (no base-domain restriction)

App containers are never port-published; they sit on core's docker network behind the central **deploy proxy on port 3003**, which routes by **Host header**. Route your edge to 3003:

- **Cloudflare Tunnel:** the tunnel's **catch-all** ingress forwards every unmatched hostname to `http://localhost:3003`. Attach a domain in **Deployments → Domains → tunnel kind**. When `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_TUNNEL_ID` are set, core **creates the proxied CNAME (`<domain>` → `<tunnel-id>.cfargotunnel.com`) automatically via the Cloudflare API** and removes it on detach. The UI shows DNS status per domain (auto-managed / failed + retry / manual guidance).
- **Host Caddy/Nginx:** add an A record then a host block `reverse_proxy 127.0.0.1:3003` (TLS at the edge). The UI generates the exact DNS table + snippet.

**No `DEPLOY_BASE_DOMAIN` is used here** — users attach arbitrary domains, and there's no base-domain restriction (any zone the CF token can read works).

### TLS depth gate

Universal SSL free covers the apex plus **one** level of subdomain (`<your-domain>` + `*.<your-domain>`). A multi-level name (a **dot inside a label** e.g. `a.b.<your-domain>`) fails TLS. The UI gates these behind a confirmation:

- `POST .../domains` returns `409 TLS_DEPTH_CONFIRMATION` (with `code`/`depth`/`zone`) when depth > 1 unless body has `confirm: true`.
- The UI shows an amber confirmation panel; a "TLS likely broken" badge appears on such cards, and `tls_risk_domains` are surfaced on the org board.
- **Prefer hyphenated labels** (`foo-bar.<your-domain>`), never dots.

## Observability defaults

- **HTTP logs**: method/path/status/duration; failures ≥ `preserve_status_min` (400) kept 7 days, others 24h — per-service tunable. Filter chips drive query params.
- **Resources**: hard caps via container `NanoCpus`/`Memory`; live CPU % of limit + working-set memory bars sample `docker stats` every ~10s.
- **Uptime**: internal prober hits each running service every ~30s, charts green/red buckets (24h/7d/30d). An **org board** shows every service in the space + a live activity feed; the dashboard shows the most active deployments with fleet uptime lanes.

## Config knobs

| Env | Default | Purpose |
|---|---|---|
| `DEPLOY_PROXY_PORT` | `3003` | central app-traffic listener (`0` disables) |
| `DEPLOY_PROXY_BIND` | `127.0.0.1` | publish binding |
| `DEPLOY_HEALTH_TIMEOUT_MS` | `30000` | max wait for a release to answer |
| `DEPLOY_PROBE_MS` / `DEPLOY_METRICS_MS` / `DEPLOY_SWEEP_MS` | `30s`/`10s`/`60s` | probe / stats / reconcile sweeps |

## Env var rules (UI + backend enforced)

Valid names `[A-Za-z_][A-Za-z0-9_]*`, no duplicates, **≤100 vars**, `KEY=value` (optional `export` prefix), quotes stripped, `#` comments and blank lines allowed but not stored. Saving is a full replace and takes effect on the next deploy.
