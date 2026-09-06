// User-directed HTTP traffic must connect to the addresses that were checked,
// not perform another DNS lookup after validation.
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch } from 'undici';

export class NetPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetPolicyError';
    this.code = 'ERR_NET_POLICY';
  }
}

export function isNetPolicyError(error) {
  return error?.code === 'ERR_NET_POLICY';
}

const BLOCKED_SUFFIXES = ['.internal', '.local', '.localdomain', '.home.arpa'];
const BLOCKED_NAMES = new Set([
  'localhost', 'host.docker.internal', 'gateway.docker.internal',
  'metadata', 'metadata.google.internal', 'instance-data',
]);
const V4_SPECIAL = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4',
].map(cidr => ipaddr.parseCIDR(cidr));
const V6_SPECIAL = ['2001::/32', '2001:2::/48', '2001:10::/28', '2001:20::/28',
  '2001:db8::/32', '2002::/16', '3fff::/20']
  .map(cidr => ipaddr.parseCIDR(cidr));
const V6_GLOBAL = ipaddr.parseCIDR('2000::/3');

export function isPrivateAddress(raw) {
  try {
    if (!net.isIP(String(raw))) return true;
    let address = ipaddr.parse(String(raw));
    if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) {
      address = address.toIPv4Address();
    }
    if (address.kind() === 'ipv4') {
      const text = address.toString();
      // Globally reachable anycast exceptions inside the protocol-assignment block.
      if (text === '192.0.0.9' || text === '192.0.0.10') return false;
      return V4_SPECIAL.some(cidr => address.match(cidr));
    }
    // Exclude transition/translation addresses as well as non-global IPv6.
    return !address.match(V6_GLOBAL) || V6_SPECIAL.some(cidr => address.match(cidr));
  } catch {
    return true;
  }
}

function blockedHostname(host) {
  const name = host.toLowerCase().replace(/\.$/, '');
  const peers = String(process.env.BLOCKED_PEER_NAMES || '').split(',').map(s => s.trim().toLowerCase());
  const suffix = String(process.env.BLOCKED_PEER_SUFFIX || '').trim().toLowerCase();
  return BLOCKED_NAMES.has(name) || BLOCKED_SUFFIXES.some(s => name.endsWith(s)) ||
    peers.includes(name) || (suffix && (name === suffix || name.endsWith(`.${suffix}`)));
}

// DNS itself has no AbortSignal API. Stop waiting without leaving an abort
// listener behind, and still observe the lookup's eventual rejection.
async function resolveAddresses(host, signal) {
  signal?.throwIfAborted();
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  let abort;
  try {
    const lookup = dns.lookup(host, { all: true, verbatim: true });
    if (!signal) return await lookup;
    return await Promise.race([
      lookup,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/**
 * Save-time validation, also used by guardedFetch for every hop.
 * allowedPrivateOrigins is an EXACT origin list supplied by a trusted caller
 * from operator configuration. No environment-wide exemption is read here.
 * Webhook callers must not pass the AI/STT allowlist.
 */
export async function assertPublicUrl(raw, { allowHttp = true, allowedPrivateOrigins = [], signal } = {}) {
  try {
    let url;
    try { url = new URL(String(raw || '').trim()); }
    catch { throw new NetPolicyError('Not a valid URL'); }
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
      throw new NetPolicyError('Only http(s) URLs are allowed');
    }
    if (url.username || url.password) throw new NetPolicyError('URLs may not contain credentials');
    const privateAllowed = Array.isArray(allowedPrivateOrigins) && allowedPrivateOrigins.some(rawOrigin => {
      try {
        const origin = new URL(rawOrigin);
        return !origin.username && !origin.password && origin.pathname === '/' &&
          !origin.search && !origin.hash && origin.origin === url.origin;
      } catch { return false; }
    });
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!privateAllowed && blockedHostname(host)) {
      throw new NetPolicyError(`Refusing to call internal host '${host}'`);
    }
    let addresses;
    try { addresses = await resolveAddresses(host, signal); }
    catch (cause) {
      if (signal?.aborted) throw signal.reason;
      const error = new Error(`Could not resolve '${host}'`, { cause });
      error.code = cause?.code || 'ERR_DNS_LOOKUP';
      throw error;
    }
    if (!addresses.length) {
      const error = new Error(`Could not resolve '${host}'`);
      error.code = 'ENOTFOUND';
      throw error;
    }
    for (const { address, family } of addresses) {
      if (!net.isIP(address) || net.isIP(address) !== family || (!privateAllowed && isPrivateAddress(address))) {
        throw new NetPolicyError(`Refusing to call '${host}' - it resolves to a private or invalid address`);
      }
    }
    return { ok: true, url, addresses };
  } catch (error) {
    return { ok: false, message: error?.message || String(error ?? 'Request aborted'), error };
  }
}

/**
 * Standard Response API, with one deadline through DNS, redirects AND body.
 * timeoutMs: 0 disables the deadline for streaming callers with their own
 * cancellation/idle timeout. The caller's signal remains active through EOF.
 */
export async function guardedFetch(raw, init = {}, { timeoutMs = 10_000, maxRedirects = 10, ...policy } = {}) {
  if (init.redirect !== undefined && !['follow', 'manual', 'error'].includes(init.redirect)) {
    throw new TypeError('Invalid redirect mode');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('Invalid fetch timeout');
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new TypeError('Invalid redirect limit');
  }
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const timer = timeoutMs ? setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs) : null;
  timer?.unref();
  const dispatchers = new Set();
  let finished = false;
  function finish(error) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    for (const dispatcher of dispatchers) {
      void (error ? dispatcher.destroy(error instanceof Error ? error : new Error(String(error))) : dispatcher.close()).catch(() => {});
    }
  }
  const onAbort = () => finish(signal.reason || new DOMException('Request aborted', 'AbortError'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    let next = raw;
    let method = String(init.method || 'GET').toUpperCase();
    let body = init.body;
    const headers = new Headers(init.headers);
    // Never let a caller-supplied Host or dispatcher override the validated origin.
    headers.delete('host');
    for (let hop = 0; ; hop++) {
      signal.throwIfAborted();
      const check = await assertPublicUrl(next, { ...policy, signal });
      if (!check.ok) throw check.error;
      signal.throwIfAborted();
      const dispatcher = new Agent({ connect: {
        lookup(host, options, callback) {
          if (host.replace(/^\[|\]$/g, '') !== check.url.hostname.replace(/^\[|\]$/g, '')) {
            callback(new NetPolicyError('Unexpected transport hostname'));
            return;
          }
          const family = Number(options.family || 0);
          const addresses = check.addresses.filter(a => !family || a.family === family);
          if (!addresses.length) { callback(Object.assign(new Error('No matching address family'), { code: 'ENOTFOUND' })); return; }
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        },
      } });
      dispatchers.add(dispatcher);
      const response = await fetch(check.url, { ...init, method, body, headers, signal, dispatcher, redirect: 'manual' });
      const location = response.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(response.status) && location && init.redirect !== 'manual') {
        await response.body?.cancel();
        void dispatcher.close().catch(() => {});
        dispatchers.delete(dispatcher);
        if (init.redirect === 'error') throw new NetPolicyError('Refusing to follow redirect');
        if (hop >= maxRedirects) throw new NetPolicyError('Too many redirects');
        let target;
        try { target = new URL(location, check.url); }
        catch { throw new NetPolicyError('Invalid redirect URL'); }
        if (target.origin !== check.url.origin) {
          for (const name of ['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'x-api-key']) headers.delete(name);
        }
        if (((response.status === 301 || response.status === 302) && method === 'POST') ||
            (response.status === 303 && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          body = undefined;
          for (const name of ['content-length', 'content-type', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
        } else if (body && (typeof body.getReader === 'function' || typeof body.pipe === 'function' || body[Symbol.asyncIterator])) {
          throw new NetPolicyError('Cannot replay a streaming request body on redirect');
        }
        next = target.href;
        continue;
      }
      if (!response.body) { finish(); return response; }
      const reader = response.body.getReader();
      const stream = new ReadableStream({
        async pull(destination) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { finish(); destination.close(); }
            else destination.enqueue(chunk.value);
          } catch (error) { finish(error); destination.error(error); }
        },
        async cancel(reason) {
          try { await reader.cancel(reason); }
          finally { finish(); }
        },
      });
      const result = new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperties(result, {
        url: { value: response.url },
        redirected: { value: hop > 0 },
      });
      return result;
    }
  } catch (error) {
    finish(error);
    throw error;
  }
}
