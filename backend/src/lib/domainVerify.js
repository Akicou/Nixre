// Custom-domain ownership proof.
//
// Attaching a domain used to be enough to route it: any user with write access
// to any repo could claim `git.nixre.dev` — or someone else's hostname — and
// the deploy proxy would serve their container for it (custom domains are
// matched before vanity/internal names, so the forge's own hostname was
// claimable too).
//
// Ownership is now proven before a domain is routed:
//
//   1. Admin-only auto-DNS path: the requesting admin authorizes the claim and
//      the operator's Cloudflare token provisions the record. Ordinary space
//      writers cannot use the operator's DNS authority as ownership proof.
//   2. Challenge path — otherwise the user publishes a TXT record
//      `_nixre-verify.<domain>` containing the issued token and calls the
//      verify endpoint. We look it up from a set of public resolvers so a
//      poisoned LAN resolver cannot forge the answer.
//   3. Admin path — an instance admin may mark any domain verified, for
//      setups where DNS is managed out of band.

import dns from 'node:dns/promises';
import crypto from 'node:crypto';

// Public resolvers avoid a local split-horizon cache. Multiple resolvers help
// availability during propagation; a matching answer is not a quorum proof.
const RESOLVERS = String(process.env.NIXRE_VERIFY_RESOLVERS || '1.1.1.1,8.8.8.8,9.9.9.9')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const VERIFY_PREFIX = '_nixre-verify';

export function newVerifyToken() {
  return `nixre-verify=${crypto.randomBytes(20).toString('base64url')}`;
}

export function verifyRecordName(domain) {
  return `${VERIFY_PREFIX}.${String(domain || '').replace(/\.$/, '')}`;
}

/**
 * Look up one TXT name on every configured resolver.
 * Returns the flattened array of TXT strings, or [] if every query fails.
 */
async function resolveTxtEverywhere(name) {
  const results = await Promise.allSettled(
    RESOLVERS.map(async server => {
      const resolver = new dns.Resolver({ timeout: 2000, tries: 2 });
      resolver.setServers([server]);
      try {
        return await resolver.resolveTxt(name);
      } finally {
        // node's Resolver has no explicit close; drop the handle.
        resolver.cancel?.();
      }
    }),
  );
  const out = [];
  for (const r of results) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const chunk of r.value) out.push(chunk.map(String).join(''));
  }
  return out;
}

/**
 * Check the challenge record for a domain.
 * @returns {Promise<{ ok: boolean, detail?: string }>}
 */
export async function checkDomainChallenge(domain, token) {
  if (!token || typeof token !== 'string') return { ok: false, detail: 'No TXT challenge has been issued' };
  const name = verifyRecordName(domain);
  let records = [];
  try {
    records = await resolveTxtEverywhere(name);
  } catch {
    records = [];
  }
  if (!records.length) {
    return { ok: false, detail: `No TXT record found at ${name}` };
  }
  const match = records.some(r => r.trim() === String(token).trim());
  if (!match) {
    return {
      ok: false,
      detail: `Found ${records.length} TXT record(s) at ${name}, but none matches the challenge token`,
    };
  }
  return { ok: true };
}

/**
 * Hostnames this instance must never let a deployment claim.
 *
 * The forge serves its own UI/API/git from these names, and the deploy proxy
 * matches custom domains first — routing one to a user container is a
 * takeover of the instance itself.
 */
export function reservedDomainSet(extra = []) {
  const reserved = new Set(
    String(process.env.NIXRE_RESERVED_DOMAINS || '')
      .split(',')
      .map(s => s.trim().toLowerCase().replace(/\.$/, ''))
      .filter(Boolean),
  );
  for (const name of extra) {
    const clean = String(name || '').trim().toLowerCase().replace(/\.$/, '');
    if (clean) reserved.add(clean);
  }
  return reserved;
}

/**
 * Reject a hostname that belongs to this instance or to a parent zone we
 * route on. Returns null when the domain is fine.
 */
export function reservedDomainReason(domain, { baseDomain, reserved }) {
  const name = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!name) return 'Enter a hostname';
  if (reserved.has(name)) {
    return `${name} is used by this Nixre instance and cannot be attached to a service`;
  }
  // Anything at or above the deployment base domain is instance-controlled
  // (svc-<id>.<base>, <name>.<base>, and the base itself).
  const base = String(baseDomain || '').trim().toLowerCase().replace(/\.$/, '');
  if (base && (name === base || name.endsWith(`.${base}`))) {
    return `${name} sits on this instance's deployment domain (${base}) and is managed automatically`;
  }
  return null;
}
