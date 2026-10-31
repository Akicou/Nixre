# Deployment runtime options

Every deploy service runs with memory/CPU caps, an `unless-stopped` restart policy, `init`, and an attachment to the approved apps network. **Runtime options** override parts of that (Docker-outside-of-Docker sandboxes, custom health endpoints, device access). They are a JSON blob stored per service and merged into the container create payload at launch.

## Where to set them

New services use security policy `2` (drop all capabilities, `no-new-privileges` on). Migration 026 keeps policy `1` for existing services so recreation and rollback do not break root-started images. Only an instance admin can PATCH `security_policy_version` to `1` or `2`. Test the image and redeploy explicitly to apply a policy change. Ordinary config edits and clearing runtime options keep the selected policy. See [the upgrade guide](security-upgrade.md) for network and secret migration.

- **Create wizard** → "Show advanced runtime options" (JSON textarea).
- **Service detail → Runtime tab** → JSON editor with live summary chips.
- **API**: `POST`/`PATCH /repos/{space}/{repo}/+/deployments/services` with a `runtime_options` object. PATCH with `null` clears back to defaults. Omitting the key leaves it untouched.

Options take effect on the next deploy. Blue/green launches a fresh container from the stored service row, so "Redeploy" (no rebuild) applies them.

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

Unknown fields are rejected. All keys are optional, and omitted keys keep current behavior.

## Safety model

Runtime options can give a container host-level powers, so they are gated and fail closed:

| Option | Requires |
|---|---|
| `host_config.binds` | instance admin **and** the host path must match `NIXRE_DEPLOY_BIND_ALLOWLIST` |
| `host_config.privileged` | instance admin **and** `NIXRE_DEPLOY_ALLOW_PRIVILEGED=true` |
| `host_config.network_mode: "host"` | instance admin **and** `NIXRE_DEPLOY_ALLOW_HOST_NETWORK=true` |
| other `host_config.*` fields | instance admin |
| `health_path`, `health_timeout_ms`, `command`, `entrypoint` | any repo writer |

To change instance policy, set the env vars on nixre-core (compose `.env`) and restart core. An empty allowlist disables bind mounts entirely.

> **Warning:** bind-mounting `/var/run/docker.sock` gives the container effective root control over the host Docker daemon. Use it only for trusted services (e.g. a sandbox runner).

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

Keep the bind-mounted host path identical inside the container if the service spawns sibling containers, because `docker run -v` resolves paths against the host filesystem.

## Internal hostnames

Unless `network_mode` replaces the default network, every service container is attached to the apps network with two DNS aliases that other containers there can resolve:

| Alias | When |
| --- | --- |
| `svc-<id>` | always |
| `<name>.<repo>.<space>.internal` | service name, repo uid and space uid are all already lowercase DNS labels |

Container names (`nixre-app-<hash>`) embed the deployment id and IPs are reassigned, so neither survives a redeploy. The aliases do. Example: `SIDECAR_URL=http://svc-15:8000`.

Uids are never sanitised into a label, and no bare `<name>` alias exists. Either would let two services share an alias, and a shared alias on a Docker network is round-robin DNS, so one repository could receive another's internal traffic. During a blue/green rollout the old and new containers both carry the aliases until the old one is retired, as with the public route.

## Related knobs

- `DEPLOY_PROXY_TIMEOUT_MS` (default 120000): idle timeout for proxied app traffic. Raise it for streaming AI services that pause between tokens.

## Diagnosing a release that never answered

`health_path` and `health_timeout_ms` decide whether a container gets traffic, so they are the most common cause of this failure:

```
Health check failed: app did not answer on port 8080 / within 30s (no response)
```

The image built. The cause is in the container's own output, which the failure handler tails into `deployments.runtime_log` before removing the container (migration 032).

```bash
# the failed deployment's build output, then its container output
curl -H "Authorization: Bearer $TOKEN" \
  ".../+/deployments/services/$ID/deployments/failed/log?stream=all"

# the container serving right now
curl -H "Authorization: Bearer $TOKEN" ".../+/deployments/services/$ID/logs?tail=200"
```

Both need **write access** on the owning space, because build output often echoes secrets. See `skills/nixre/references/deploy-api.md` for the full route list.

Usual causes, most common first:

- The app bound `127.0.0.1` instead of `0.0.0.0`.
- `container_port` does not match what the app listens on.
- Startup takes longer than the health budget.
- A missing env var (env changes apply only on the next deploy).
