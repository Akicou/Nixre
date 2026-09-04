-- 022_cf_domains.sql — remember Cloudflare-managed DNS records for
-- tunnel-routed custom domains (created via the CF API when
-- CLOUDFLARE_API_TOKEN/CLOUDFLARE_TUNNEL_ID are set) so domain removal can
-- delete the record again. NULL ids = manually managed at the registrar.

ALTER TABLE deploy_domains ADD COLUMN IF NOT EXISTS cf_zone_id TEXT;
ALTER TABLE deploy_domains ADD COLUMN IF NOT EXISTS cf_record_id TEXT;
