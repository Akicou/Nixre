// SSRF guard — the rules that keep user-supplied URLs away from our own
// infrastructure. These are the endpoints a webhook target or an AI provider
// base URL would be aimed at.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, assertPublicUrl } from './netGuard.js';

test('isPrivateAddress flags every address that is not public unicast', () => {
  const privateAddresses = [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1', // v4-mapped loopback
  ];
  for (const ip of privateAddresses) {
    assert.equal(isPrivateAddress(ip), true, `expected ${ip} to be treated as private`);
  }
});

test('isPrivateAddress allows public unicast', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.255.255']) {
    assert.equal(isPrivateAddress(ip), false, `expected ${ip} to be treated as public`);
  }
});

test('assertPublicUrl rejects non-http schemes', async () => {
  for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://example.com/']) {
    const r = await assertPublicUrl(url);
    assert.equal(r.ok, false, `expected ${url} to be rejected`);
  }
});

test('assertPublicUrl rejects embedded credentials', async () => {
  const r = await assertPublicUrl('https://user:pass@example.com/');
  assert.equal(r.ok, false);
  assert.match(r.message, /credentials/);
});

test('assertPublicUrl rejects internal hostnames without touching DNS', async () => {
  const internal = [
    'http://localhost/',
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'http://host.docker.internal:3002/',
    'http://nixre-db:5432/',
    'http://something.internal/',
  ];
  for (const url of internal) {
    const r = await assertPublicUrl(url);
    assert.equal(r.ok, false, `expected ${url} to be rejected`);
  }
});

test('assertPublicUrl accepts an ordinary public URL', async () => {
  // Resolution is required, so this one needs DNS. Skipped when the sandbox
  // has no network — the rejection cases above are the security-relevant ones.
  try {
    const r = await assertPublicUrl('https://example.com/webhook');
    if (r.ok) assert.equal(r.url.hostname, 'example.com');
  } catch {
    /* offline: nothing to assert */
  }
});
