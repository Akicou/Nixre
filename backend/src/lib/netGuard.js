// Outbound request guard — SSRF defence for anything the server fetches on a
// user's behalf (AI provider base URLs, webhook targets, STT endpoints).
//
// The rule: a user may point us at the public internet, not at our own
// infrastructure. Every candidate URL is resolved first and rejected when it
// lands on loopback, link-local (cloud metadata at 169.254.169.254), the
// private RFC1918 ranges, IPv6 ULA/link-local, or a docker-internal name.
//
// Resolution is mandatory rather than best-effort: a hostname that fails to
// resolve cannot be proven public, so it is refused.

import dns from 'node:dns/promises';
import net from 'node:net';

// Hostnames that only ever mean "something inside this deployment".
const BLOCKED_HOST_SUFFIXES = [
  '.internal',
  '.local',
  '.localdomain',
  '.home.arpa',
];
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'host.docker.internal',
  'gateway.docker.internal',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

function isBlockedHostname(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_HOST_SUFFIXES.some(s => h.endsWith(s))) return true;

  // Container names inside the compose project (nixre-core, nixre-db, …) are
  // resolvable from core and must never be a user-reachable fetch target.
  const composeName = String(process.env.BLOCKED_PEER_NAMES || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (composeName.includes(h)) return true;
  if (String(process.env.BLOCKED_PEER_SUFFIX || '').trim()) {
    const suffix = String(process.env.BLOCKED_PEER_SUFFIX).trim().toLowerCase();
    if (h === suffix || h.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

/** True for any address that is not a legitimate public unicast destination. */
export function isPrivateAddress(ip) {
  const v = String(ip || '');

  // IPv4-mapped IPv6 (::ffff:127.0.0.1) — normalise to the v4 form.
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateAddress(mapped[1]);

  if (net.isIPv4(v)) {
    const parts = v.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // 10/8 private
    if (a === 127) return true; // 127/8 loopback
    if (a === 169 && b === 254) return true; // 169.254/16 link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
    if (a === 192 && b === 168) return true; // 192.168/16 private
    if (a === 192 && b === 0) return true; // 192.0.0/24, 192.0.2/24 (TEST-NET-1)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (net.isIPv6(v)) {
    const lower = v.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified / loopback
    if (lower.startsWith('fe80')) return true; // link-local
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
    if (lower.startsWith('ff')) return true; // multicast
    return false;
  }

  // Not an IP literal — caller should have resolved it first.
  return true;
}

/**
 * Validate a user-supplied URL before the server fetches it.
 *
 * @returns {Promise<{ ok: true, url: URL } | { ok: false, message: string }>}
 */
export async function assertPublicUrl(raw, { allowHttp = true } = {}) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, message: 'Not a valid URL' };
  }

  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return { ok: false, message: 'Only http(s) URLs are allowed' };
  }
  // Anything with embedded credentials is a phishing/SSRF smell.
  if (url.username || url.password) {
    return { ok: false, message: 'URLs may not contain credentials' };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) {
    return { ok: false, message: `Refusing to call internal host '${host}'` };
  }

  // A bare IP literal skips DNS but must still be checked.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      return { ok: false, message: 'Refusing to call a private or loopback address' };
    }
    return { ok: true, url };
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, message: `Could not resolve '${host}'` };
  }
  if (!addresses.length) {
    return { ok: false, message: `Could not resolve '${host}'` };
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      return {
        ok: false,
        message: `Refusing to call '${host}' — it resolves to a private address (${address})`,
      };
    }
  }
  return { ok: true, url };
}

/**
 * `fetch` wrapper that enforces assertPublicUrl, refuses redirects to
 * non-public targets, and applies a hard timeout.
 */
export async function guardedFetch(raw, init = {}, { timeoutMs = 10_000, ...opts } = {}) {
  const check = await assertPublicUrl(raw, opts);
  if (!check.ok) throw new Error(check.message);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // redirect: 'manual' — every hop is re-validated below.
    const response = await fetch(check.url, {
      ...init,
      signal: controller.signal,
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      const redirectCheck = await assertPublicUrl(new URL(location, check.url).href, opts);
      if (!redirectCheck.ok) {
        throw new Error(`Refusing to follow redirect: ${redirectCheck.message}`);
      }
      return guardedFetch(redirectCheck.url, init, { timeoutMs, ...opts });
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}
