# Deployment runtime options

Every deploy service runs with sane defaults: memory/CPU caps, `unless-stopped`
restart policy, `init`, and an attachment to core's Docker network. Services
with special needs (Docker-outside-of-Docker sandboxes, custom health
endpoints, device access) can override parts of that via **runtime options** —
a JSON blob stored per service and merged into the container create payload at
launch time.

## Where to set them

- **Create wizard** → "Show advanced runtime options" (JSON textarea).
- **Service detail → Runtime tab** → JSON editor with live summary chips.
- **API**: `POST`/`PATCH /repos/{space}/{repo}/+/deployments/services`
  with a `runtime_options` object (PATCH with `null` clears back to defaults;
  omitting the key leaves it untouched).

Options take effect on the **next deploy** — blue/green launches a fresh
container from the stored service row, so a redeploy (no rebuild needed via
"Redeploy") applies them safely.

## Schema

```jsonc
{
  "version": 1,
  "health_path": "/health",        // release probe + uptime probe path
  "health_timeout_ms": 30000,      // optional per-service health budget
  "command": ["…"],                // container Cmd override
  "entrypoint": ["…"],             // container Entrypoint override
  "host_config": {
    "binds": ["/host/path:/container/path:rw"],
    "privileged": false,
    "cap_add": ["NET_ADMIN"],
    "cap_drop": ["CHOWN"],
    "devices": ["/dev/kvm:/dev/kvm:rwm"],
    "group_add": [998],
    "extra_hosts": ["db:10.0.0.5"],
    "shm_size": 268435456,         // bytes
    "tmpfs": { "/run": "" },
    "network_mode": null           // bridge | none | host | container:<name>
  }
}
```

Unknown fields are rejected (typo-proofing). Everything optional — omitted
keys keep current behavior.

## Safety model (fail closed)

Runtime options can grant a container host-level powers, so they are gated:

| Option | Requires |
|---|---|
| `host_config.binds` | instance admin **and** the host path must match `NIXRE_DEPLOY_BIND_ALLOWLIST` |
| `host_config.privileged` | instance admin **and** `NIXRE_DEPLOY_ALLOW_PRIVILEGED=true` |
| `host_config.network_mode: "host"` | instance admin **and** `NIXRE_DEPLOY_ALLOW_HOST_NETWORK=true` |
| other `host_config.*` fields | instance admin |
| `health_path`, `health_timeout_ms`, `command`, `entrypoint` | any repo writer |

Set the env vars on nixre-core (compose `.env`) and restart core to change
instance policy. An empty allowlist disables bind mounts entirely.

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
      "/var/lib/nayhein-sandbox:/var/lib/nayhein-sandbox"
    ],
    "group_add": [998]
  }
}
```

With compose `.env`:

```
NIXRE_DEPLOY_BIND_ALLOWLIST=/var/run/docker.sock,/var/lib/nayhein-sandbox
```

The bind-mounted host path must be identical inside the container when the
service spawns *sibling* containers (`docker run -v` resolves against the
**host** filesystem), which is exactly what the sandbox runner needs.

## Related knobs

- `DEPLOY_PROXY_TIMEOUT_MS` (default 120000) — idle timeout for proxied app
  traffic; raise it for streaming AI services that pause between tokens.
