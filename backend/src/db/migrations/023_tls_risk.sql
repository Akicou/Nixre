-- 023_tls_risk.sql — flag custom domains whose TLS will break on Cloudflare
-- free plans (multi-level subdomains are outside Universal SSL's *.zone
-- coverage). Computed at attach time when the CF token can see the zone.

ALTER TABLE deploy_domains ADD COLUMN IF NOT EXISTS tls_risk BOOLEAN NOT NULL DEFAULT FALSE;
