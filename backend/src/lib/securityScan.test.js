import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintFindings, isSafeCommand, issueFingerprint, nodeSecurityLag, osvDistroEcosystem, parseApkInfo,
  parseDpkg, parseNpmTree, parseOsRelease, parsePipList, summarizeOsvVuln,
} from './securityScan.js';
import { cleanLabels, validateIssueInput } from './issues.js';

test('exec allowlist accepts exact read-only argv only', () => {
  assert.ok(isSafeCommand(['node', '-v']));
  assert.ok(isSafeCommand(['cat', '/etc/os-release']));
  for (const bad of [
    ['sh', '-c', 'id'], ['cat', '/etc/shadow'], ['node', '-e', 'process.exit()'], ['node', '-v', '&&', 'id'],
    ['npm', 'install'], ['node'], [], 'node -v', null, ['node', 5],
  ]) assert.equal(isSafeCommand(bad), false, JSON.stringify(bad));
});

test('node lag flags a newer security release on the same major only', () => {
  const index = [
    { version: 'v22.23.4', security: true }, { version: 'v22.23.3', security: false },
    { version: 'v22.23.2', security: true }, { version: 'v24.9.0', security: true },
  ];
  assert.deepEqual(nodeSecurityLag('v22.23.2', index), {
    running: 'v22.23.2', latest: 'v22.23.4', securityReleasesBehind: 1, newestSecurityRelease: 'v22.23.4',
  });
  assert.equal(nodeSecurityLag('v22.23.4', index), null);
  // a newer release that is NOT a security release is not a finding
  assert.equal(nodeSecurityLag('v22.23.3', [{ version: 'v22.23.4', security: false }]), null);
});

test('npm tree is flattened and deduped', () => {
  const pkgs = parseNpmTree({ dependencies: { a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } }, b: { version: '2.0.0' } } });
  assert.deepEqual(pkgs.map(p => `${p.name}@${p.version}`).sort(), ['a@1.0.0', 'b@2.0.0']);
});

test('distro parsers map to OSV ecosystems', () => {
  const os = parseOsRelease('ID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME="Alpine Linux v3.20"\n');
  assert.equal(osvDistroEcosystem(os), 'Alpine:v3.20');
  assert.equal(osvDistroEcosystem(parseOsRelease('ID=debian\nVERSION_ID="12"\n')), 'Debian:12');
  assert.equal(osvDistroEcosystem(parseOsRelease('ID=arch\n')), null);
  assert.deepEqual(parseApkInfo('musl-1.2.5-r0\nca-certificates-bundle-20240705-r0\n', 'Alpine:v3.20'), [
    { name: 'musl', version: '1.2.5-r0', ecosystem: 'Alpine:v3.20' },
    { name: 'ca-certificates-bundle', version: '20240705-r0', ecosystem: 'Alpine:v3.20' },
  ]);
  assert.equal(parseDpkg('openssl\t3.0.11-1\nopenssl\t3.0.11-1\n', 'Debian:12').length, 1);
  assert.deepEqual(parsePipList([{ name: 'flask', version: '3.0.0' }, {}]), [{ name: 'flask', version: '3.0.0', ecosystem: 'PyPI' }]);
});

test('osv summary extracts severity, CVE aliases and fixed versions', () => {
  const s = summarizeOsvVuln({
    id: 'GHSA-x', aliases: ['CVE-2026-1', 'GHSA-y'], summary: 'bad', database_specific: { severity: 'high' },
    affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '1.2.3' }] }] }],
  });
  assert.deepEqual(s, { id: 'GHSA-x', aliases: ['CVE-2026-1'], summary: 'bad', severity: 'HIGH', fixed: ['1.2.3'] });
});

test('finding fingerprint ignores order and changes with the finding set', () => {
  const a = { target: 't', kind: 'npm', package: 'x', version: '1', ids: ['B', 'A'] };
  const b = { target: 't', kind: 'npm', package: 'y', version: '1', ids: ['C'] };
  assert.equal(fingerprintFindings([a, b]), fingerprintFindings([b, { ...a, ids: ['A', 'B'] }]));
  assert.notEqual(fingerprintFindings([a]), fingerprintFindings([a, b]));
  assert.notEqual(issueFingerprint('s/r', 'k1'), issueFingerprint('s/r', 'k2'));
});

test('issue input validation', () => {
  assert.ok(validateIssueInput({ title: '  ', body: '' }).error);
  assert.ok(validateIssueInput({ title: 'x'.repeat(201) }).error);
  assert.deepEqual(validateIssueInput({ title: ' hi ', body: 'b' }), { title: 'hi', body: 'b' });
  assert.deepEqual(cleanLabels(['a', 'a', ' ', 'b']), ['a', 'b']);
});
