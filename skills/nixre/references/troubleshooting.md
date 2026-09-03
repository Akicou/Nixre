# Troubleshooting

## Start here

```bash
cd <nixre-dir> && docker compose ps               # are the 3 backend containers up?
curl -s http://127.0.0.1:3001/healthz            # core answering? → {"ok":true}
docker logs --tail 50 nixre-core                 # backend errors
systemctl --user status cloudflared-<name>        # is the tunnel running?
curl -s https://git.<your-domain>/ | head -c 200  # does the SPA load?
```

## A UI feature 500s / breaks on one endpoint

Most likely a **backend route → helper param mismatch**. The route declares `:id` but a helper reads `req.params.serviceId` (or vice versa) → `NaN`/`undefined`, often a `bigint` cast error. This crashed every `/deployments/services/:id/*` endpoint at one point.

1. Read `docker logs nixre-core` — the stack trace names the route and the failing helper.
2. Compare the route param name (`routes/…:id`) to the read inside the helper (`req.params.X`).
3. Fix the param name (or add a 404 guard for non-numeric ids). Rebuild core: `docker compose up -d --build nixre-core`.

## Stale / old UI in the browser

The Caddyfile sets `/index.html` to no-cache and `/assets/*` to immutable. If you still see an old bundle:

- Hard-reload: `Ctrl+Shift+R` (Mac `Cmd+Shift+R`).
- Check which bundle is served: `curl -s https://git.<your-domain>/ | grep -o 'assets/index-[^\"]*'`.
- If it's unchanged after a rebuild, confirm Caddy serves `ui/dist` (not a stale copy) and that the build wrote a new hash.

## Domain won't get a cert / "TLS likely broken"

Universal SSL covers one level of subdomain. If the label contains a **dot** (`a.b.<your-domain>`), TLS fails. Use hyphenated labels (`a-b.<your-domain>`). The UI gates depth > 1 behind a confirmation (`409 TLS_DEPTH_CONFIRMATION`, body needs `confirm: true`).

## "Deployed domain not accepting traffic" (503 at the proxy)

The chain is: **domain → CNAME → edge (Cloudflare Tunnel / host Caddy) → deploy proxy :3003 → container**. Break it down:

- `dig @1.1.1.1 +short <domain>` → should point at `<tunnel-id>.cfargotunnel.com` (tunnel case) or your host A record.
- Confirm the tunnel's catch-all ingress goes to `http://localhost:3003` (`~/.cloudflared/config.yml`).
- Confirm the proxy routes by Host header and the service's port matches the container port.
- Confirm the service is `running` (not `stopped`) and a healthy release exists.

## Auto-DNS failing (custom domains)

Automatic CNAME creation/removal needs the Cloudflare token to have **`Zone:Read` + `DNS:Edit`** on the domain's zone. Symptoms: a domain shows "failed (retry)" or only manual guidance. Fix: create/replace the token with `DNS:Edit`, set it in `.env` (`CLOUDFLARE_API_TOKEN`), restart core. Also make sure `CLOUDFLARE_TUNNEL_ID` is set so CNAMEs point at the right tunnel.

> If the token only has `Zone:Read`, zones are discovered but records can't be written — a very common gotcha.

## DNS "seems wrong" on your machine

Your LAN resolver may cache NXDOMAIN aggressively, so a domain created moments ago can look missing. Verify with a public resolver:

```bash
dig @1.1.1.1 +short <name>          # authoritative-ish answer
curl --resolve <name>:443:<edge-ip> https://<name>   # bypass DNS
```

## SSH clone/push fails

- **Connectivity**: `ssh -T` should reach `nixre-ssh`. The tunnel maps `ssh.<your-domain> → localhost:3022`. From the host itself, use `ProxyCommand cloudflared access ssh`.
- **Keys**: the key must be registered at **Settings → SSH Keys**. Each session is locked by a per-key git-shell that ACL-checks the repo — key known but repo not allowed → denied.
- **HTTPS auth fails** (`Authentication failed`): the password must be a **PAT**, not your account password. Mint a new one (lifetime-limited).

## A whole feature is "there but not working"

The UI is a SPA (often served by host Caddy), but **logic lives in `nixre-core`**. If the UI renders but a call fails, the backend endpoint is the suspect — check its logs. If the UI itself is missing, the bundle is stale or Caddy isn't serving the latest `ui/dist`.

## Reasoning tokens doubled (in UI and saved chat)

This was a backend emit bug: some gateways send the same reasoning delta under two fields in one chunk (`reasoning` + `reasoning_details`, or `thinking` + `reasoning_content`). Fixed in `backend/src/lib/ai.js` — `extractReasoningTexts` now dedupes per source, and a stream-wide flag guards the final-`message` fallback. Make sure the running core has the fix. Existing transcripts that were already saved doubled stay doubled (historical data); new turns are clean.

## General dev loop

```bash
cd <nixre-dir>
cd ui && npm test                  # vitest
cd ../backend && npm test          # node --test
cd ui && npx tsc --noEmit          # type-check
cd ui && npm run build && cd .. && docker compose up -d --build nixre-core
```
