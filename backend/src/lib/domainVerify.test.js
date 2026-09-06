// Custom-domain ownership policy.
//
// Regression: attaching a domain used to be enough to route it, so any space
// writer could claim the forge's own hostname (or anyone else's) and the deploy
// proxy — which matches custom domains before every other rule — would serve
// their container from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newVerifyToken,
  verifyRecordName,
  checkDomainChallenge,
  reservedDomainSet,
  reservedDomainReason,
} from './domainVerify.js';

test('verify tokens are long, url-safe and unique', () => {
  const a = newVerifyToken();
  const b = newVerifyToken();
  assert.notEqual(a, b);
  assert.match(a, /^nixre-verify=[A-Za-z0-9_-]{20,}$/);
  assert.ok(a.length > 24);
});

test('the challenge record is scoped to the domain', () => {
  assert.equal(verifyRecordName('app.example.com'), '_nixre-verify.app.example.com');
  // A trailing dot must not produce a double dot.
  assert.equal(verifyRecordName('app.example.com.'), '_nixre-verify.app.example.com');
});

test('checkDomainChallenge fails when no record is published', async () => {
  // A random subdomain of example.com will not have our TXT record. Needs DNS;
  // skipped when offline — the reserved-name rules below are the security-critical
  // ones and never touch the network.
  try {
    const out = await checkDomainChallenge(`nope-${Date.now()}.example.com`, newVerifyToken());
    assert.equal(out.ok, false);
    assert.match(out.detail, /TXT/);
  } catch {
    /* offline */
  }
});

test('reservedDomainReason blocks the instance\'s own hostnames', () => {
  const reserved = reservedDomainSet(['git.example.com', 'ssh.example.com']);
  assert.match(
    reservedDomainReason('git.example.com', { baseDomain: '', reserved }),
    /used by this Nixre instance/,
  );
  assert.match(
    reservedDomainReason('SSH.example.com', { baseDomain: '', reserved }),
    /used by this Nixre instance/,
    'matching is case-insensitive',
  );
});

test('reservedDomainReason blocks anything on the deployment base domain', () => {
  const reserved = reservedDomainSet([]);
  assert.match(
    reservedDomainReason('apps.example.com', { baseDomain: 'apps.example.com', reserved }),
    /deployment domain/,
  );
  assert.match(
    reservedDomainReason('svc-3.apps.example.com', { baseDomain: 'apps.example.com', reserved }),
    /deployment domain/,
  );
  assert.match(
    reservedDomainReason('a.b.apps.example.com', { baseDomain: 'apps.example.com', reserved }),
    /deployment domain/,
    'multi-level names under the base are instance-managed too',
  );
});

test('reservedDomainReason allows an unrelated hostname', () => {
  const reserved = reservedDomainSet(['git.example.com']);
  assert.equal(
    reservedDomainReason('myapp.someone-else.com', { baseDomain: 'apps.example.com', reserved }),
    null,
  );
});

test('NIXRE_RESERVED_DOMAINS is honoured', () => {
  const prev = process.env.NIXRE_RESERVED_DOMAINS;
  process.env.NIXRE_RESERVED_DOMAINS = 'panel.example.org, www.example.org';
  const reserved = reservedDomainSet();
  assert.ok(reserved.has('panel.example.org'));
  assert.ok(reserved.has('www.example.org'));
  assert.equal(
    typeof reservedDomainReason('panel.example.org', { baseDomain: '', reserved }),
    'string',
  );
  process.env.NIXRE_RESERVED_DOMAINS = prev ?? '';
});
