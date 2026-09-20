-- 028_edge_observability.sql — see the outage the container probe cannot see.
--
-- Until now every uptime check hit the app container directly on core's docker
-- network. That proves the app is alive; it proves nothing about whether the
-- public can reach it. When the Cloudflare tunnel dropped, every service stayed
-- green while all of them were unreachable from the internet.
--
-- `scope` records which path a check took: 'origin' is the container probe that
-- already existed, 'public' is the same service fetched over its own hostname,
-- through the tunnel. Existing rows are origin checks, which is why that is the
-- default.

ALTER TABLE deploy_uptime_checks ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'origin';
CREATE INDEX IF NOT EXISTS uptime_recent_scope ON deploy_uptime_checks (service_id, scope, ts DESC);

-- Health of the cloudflared tunnel itself, scraped from its local metrics
-- endpoint. `connections` is cloudflared_tunnel_ha_connections: the number of
-- registered edge connections, and 0 means nothing public can reach this host.
-- `total_requests` is monotonic, so a flat series while public probes fail is
-- the signature of a tunnel that registered but is not being routed traffic.
CREATE TABLE IF NOT EXISTS tunnel_health (
  id             BIGSERIAL PRIMARY KEY,
  connections    INTEGER NOT NULL,
  total_requests BIGINT,
  reachable      BOOLEAN NOT NULL,
  ts             BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS tunnel_health_recent ON tunnel_health (ts DESC);
