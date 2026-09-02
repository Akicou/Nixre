// cloudflareDns.js — Cloudflare DNS automation for deployed-app custom domains.
//
// When the operator sets CLOUDFLARE_API_TOKEN and CLOUDFLARE_TUNNEL_ID, adding
// a `tunnel`-kind domain to a deployment auto-creates a proxied CNAME pointing
// at the tunnel (<tunnel-id>.cfargotunnel.com); removing the domain removes the
// record again. The tunnel's catch-all ingress forwards unmatched hostnames to
// the deploy proxy, which routes by Host header — so no per-domain tunnel
// config change is ever needed.
//
// Token requirements (Cloudflare dashboard → My Profile → API Tokens):
//   Zone → Zone → Read  (account-wide, so zone lookup works)
//   Zone → DNS → Edit   (on every zone users may attach domains from)
//
// Without the token everything degrades to the manual guidance snippets the
// UI already shows.

const API = 'https://api.cloudflare.com/client/v4';

export function cloudflareConfigured() {
  return Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_TUNNEL_ID);
}

export function tunnelCnameTarget() {
  return `${process.env.CLOUDFLARE_TUNNEL_ID}.cfargotunnel.com`;
}

async function cfFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const errors = body?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new Error(errors || `Cloudflare API responded ${res.status}`);
  }
  return body.result;
}

// Walk suffixes upward from the full hostname until a zone the token can see
// matches: app.staging.example.com -> staging.example.com -> example.com.
async function findZoneId(domain) {
  const labels = domain.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    const zones = await cfFetch(`/zones?name=${encodeURIComponent(candidate)}`);
    if (zones.length) return { zoneId: zones[0].id, zoneName: zones[0].name };
  }
  throw new Error(`No Cloudflare zone matching "${domain}" is visible to this API token`);
}

// Create (idempotently) the proxied CNAME pointing `domain` at the tunnel.
// Returns { recordId, zoneId, existed } so the route can persist the ids for
// later cleanup.
export async function createTunnelCname(domain) {
  const { zoneId, zoneName } = await findZoneId(domain);
  const target = tunnelCnameTarget();
  const existing = await cfFetch(
    `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(domain)}`,
  );
  if (existing.length) {
    const rec = existing[0];
    if (rec.content === target && rec.proxied) {
      return { recordId: rec.id, zoneId, zoneName, existed: true };
    }
    // A stale/conflicting record exists — update it instead of piling up
    // duplicates (Cloudflare rejects duplicate CNAMEs on the same name).
    const updated = await cfFetch(`/zones/${zoneId}/dns_records/${rec.id}`, {
      method: 'PUT',
      body: JSON.stringify({ type: 'CNAME', name: domain, content: target, proxied: true, ttl: 1 }),
    });
    return { recordId: updated.id, zoneId, zoneName, existed: true };
  }
  const rec = await cfFetch(`/zones/${zoneId}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'CNAME', name: domain, content: target, proxied: true, ttl: 1 }),
  });
  return { recordId: rec.id, zoneId, zoneName, existed: false };
}

export async function deleteDnsRecord(zoneId, recordId) {
  await cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
}
