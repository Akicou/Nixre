// Pure deployment helpers — no DB / network / Docker needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRootDir,
  filterDockerfiles,
  archiveSpec,
  resolveRoute,
  subdomainHost,
  computeUsage,
  makeImageTag,
  containerName,
  shortSha,
  bucketizeUptime,
  statusClass,
  sanitizeServiceName,
} from './deployPure.js';

test('normalizeRootDir cleans separators and stays inside the repo', () => {
  assert.equal(normalizeRootDir(''), '.');
  assert.equal(normalizeRootDir('.'), '.');
  assert.equal(normalizeRootDir('/'), '.');
  assert.equal(normalizeRootDir('apps/web'), 'apps/web');
  assert.equal(normalizeRootDir('./apps/web/'), 'apps/web');
  assert.equal(normalizeRootDir('/apps/web'), 'apps/web');
  assert.equal(normalizeRootDir('apps//web'), 'apps/web');
  assert.throws(() => normalizeRootDir('../etc'));
  assert.throws(() => normalizeRootDir('a/../../b'));
});

test('filterDockerfiles finds Dockerfiles under a root dir and relativizes them', () => {
  const tree = [
    'README.md',
    'Dockerfile',
    'docker-compose.yml',
    'apps/web/Dockerfile',
    'apps/web/Dockerfile.dev',
    'apps/api/dockerfile', // case-insensitive match
    'apps/web/src/main.rs',
    'docs/Dockerfiles.md',
  ];
  const root = filterDockerfiles(tree, '.').map(d => d.file);
  assert.deepEqual(root.sort(), [
    'Dockerfile',
    'apps/api/dockerfile',
    'apps/web/Dockerfile',
    'apps/web/Dockerfile.dev',
  ]);

  const web = filterDockerfiles(tree, 'apps/web').map(d => d.file);
  assert.deepEqual(web.sort(), ['Dockerfile', 'Dockerfile.dev']);
  // repo-relative path preserved alongside
  assert.ok(filterDockerfiles(tree, 'apps/web').every(d => d.path.startsWith('apps/web/')));
});

test('archiveSpec builds subtree revspecs', () => {
  assert.equal(archiveSpec('abc123', '.'), 'abc123');
  assert.equal(archiveSpec('abc123', 'apps/web'), 'abc123:apps/web');
});

const ROUTES = [
  { host: 'app.example.com', serviceId: 7 },
  { host: 'api.example.com', serviceId: 3 },
];

test('resolveRoute matches hosts case-insensitively, ignoring port', () => {
  assert.equal(resolveRoute('app.example.com', ROUTES), 7);
  assert.equal(resolveRoute('APP.Example.COM:443', ROUTES), 7);
  assert.equal(resolveRoute('api.example.com', ROUTES), 3);
  assert.equal(resolveRoute('unknown.example.com', ROUTES), null);
  assert.equal(resolveRoute('', ROUTES), null);
  assert.equal(resolveRoute('app.example.com.evil.io', ROUTES), null);
});

test('resolveRoute resolves fleet subdomains against a base domain', () => {
  const base = [{ host: subdomainHost('web', 'apps.nixre.dev'), serviceId: 5 }];
  assert.equal(base[0].host, 'web.apps.nixre.dev');
  assert.equal(resolveRoute('web.apps.nixre.dev', base), 5);
  assert.equal(resolveRoute('nope.apps.nixre.dev', base), null);
});

const STATS = {
  cpu_stats: {
    cpu_usage: { total_usage: 2_000_000_000 },
    system_cpu_usage: 20_000_000_000,
    online_cpus: 8,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 1_900_000_000 },
    system_cpu_usage: 19_000_000_000,
  },
  memory_stats: { usage: 300 * 1024 * 1024 },
};

test('computeUsage reports percentages relative to the configured limits', () => {
  // delta_total=1e8ns / delta_system=1e9ns = 10% of ALL machine time,
  // so average cores used = 0.1 * 8 = 0.8. Against a 4-core cap that is 20%.
  const usage = computeUsage(STATS, { cpuNanoCpus: 4 * 1e9, memoryBytes: 1024 * 1024 * 1024 });
  assert.ok(Math.abs(usage.cpuPctOfLimit - 20) < 0.01);
  assert.equal(Math.round(usage.memUsedBytes / 1024 / 1024), 300);
  assert.ok(Math.abs(usage.memPctOfLimit - (300 / 1024) * 100) < 0.01);
});

test('computeUsage allows transient >100% readings and guards divide-by-zero', () => {
  // 0.8 cores against a half-core quota reads >100% between throttle windows.
  const over = computeUsage(STATS, { cpuNanoCpus: 5e8, memoryBytes: 1024 });
  assert.ok(Math.abs(over.cpuPctOfLimit - 160) < 0.01);
  assert.ok(over.memPctOfLimit > 100);

  const zero = computeUsage(
    {
      cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      memory_stats: {},
    },
    { cpuNanoCpus: 1e9, memoryBytes: 1e9 },
  );
  assert.equal(zero.cpuPctOfLimit, 0);
  assert.equal(zero.memPctOfLimit, 0);
});

test('naming helpers produce docker-safe deterministic values', () => {
  assert.equal(makeImageTag(12, 34), 'nixre-app-svc12-dep34:nixre');
  assert.match(containerName(12, 34), /^nixre-app-[a-f0-9]{10}$/);
  assert.equal(containerName(12, 34), containerName(12, 34));
  assert.notEqual(containerName(12, 34), containerName(12, 35));
});

test('shortSha truncates display shas', () => {
  assert.equal(shortSha(''), '');
  assert.equal(shortSha(null), '');
  assert.equal(shortSha('deadbeef1234567890'), 'deadbee');
});

test('bucketizeUptime folds probes into fixed buckets with null gaps', () => {
  const t0 = 1_700_000_000_000;
  const minute = 60_000;
  const checks = [
    { ts: t0 + 10_000, ok: true },
    { ts: t0 + 20_000, ok: true },
    { ts: t0 + minute + 30_000, ok: false },
    { ts: t0 + 3 * minute + 5_000, ok: true },
  ];
  const buckets = bucketizeUptime(checks, t0, t0 + 5 * minute, minute);
  assert.equal(buckets.length, 5);
  assert.equal(buckets[0].state, 'up');
  assert.equal(buckets[1].state, 'down');
  assert.equal(buckets[2].state, 'empty'); // no probes in this window
  assert.equal(buckets[3].state, 'up');
  assert.equal(buckets[4].state, 'empty');
  assert.deepEqual(bucketizeUptime([], t0, t0 + minute, minute), [
    { start: t0, state: 'empty' },
  ]);
});

test('statusClass maps HTTP codes into UI classes', () => {
  assert.equal(statusClass(200), '2xx');
  assert.equal(statusClass(301), '3xx');
  assert.equal(statusClass(404), '4xx');
  assert.equal(statusClass(503), '5xx');
  assert.equal(statusClass(null), 'none');
  assert.equal(statusClass(undefined), 'none');
});

test('sanitizeServiceName lowercases and slugifies service names', () => {
  assert.equal(sanitizeServiceName('My API!'), 'my-api');
  assert.equal(sanitizeServiceName('--weird__name--'), 'weird-name');
  assert.equal(sanitizeServiceName('a'.repeat(100)).length <= 40, true);
});

// --- proxy routing: custom domains -------------------------------------------
//
// Regression: buildRoutes used to route every attached custom domain with no
// ownership check, so any space writer could claim a hostname (including the
// forge's own) and the proxy — which matches custom domains first — would serve
// their container from it.

import { buildRoutes } from './deployProxy.js';

test('buildRoutes skips unverified custom domains', () => {
  const routes = buildRoutes(
    [
      { domain: 'verified.example.com', service_id: 1, verified: true },
      { domain: 'parked.example.com', service_id: 2, verified: false },
    ],
    [],
    '',
  );
  const hosts = routes.map(r => r.host);
  assert.ok(hosts.includes('verified.example.com'));
  assert.ok(!hosts.includes('parked.example.com'), 'unverified domains must not be routed');
});

test('buildRoutes keeps explicitly grandfathered rows but fails closed on missing verification', () => {
  const routes = buildRoutes([
    { domain: 'legacy.example.com', service_id: 1, verified: true },
    { domain: 'unknown.example.com', service_id: 2 },
  ], [], '');
  assert.ok(routes.some(r => r.host === 'legacy.example.com'));
  assert.ok(!routes.some(r => r.host === 'unknown.example.com'));
});

test('final route table reserves custom, vanity and deterministic hostnames', t => {
  const previous = process.env.NIXRE_RESERVED_DOMAINS;
  process.env.NIXRE_RESERVED_DOMAINS = 'git.example.com,svc-8.example.com';
  t.after(() => {
    if (previous === undefined) delete process.env.NIXRE_RESERVED_DOMAINS;
    else process.env.NIXRE_RESERVED_DOMAINS = previous;
  });
  const routes = buildRoutes([
    { domain: 'git.example.com', service_id: 99, verified: true },
    { domain: 'svc-7.example.com', service_id: 99, verified: true },
  ], [{ id: 7, name: 'git' }, { id: 8, name: 'web' }], 'example.com');
  assert.equal(resolveRoute('git.example.com', routes), null);
  assert.equal(resolveRoute('svc-8.example.com', routes), null);
  assert.equal(resolveRoute('svc-7.example.com', routes), 7);
  assert.equal(resolveRoute('web.example.com', routes), 8);
});

test('a vanity name cannot shadow another service deterministic address', () => {
  const routes = buildRoutes([], [{ id: 8, name: 'svc-7' }, { id: 7, name: 'web' }], 'apps.example.com');
  assert.equal(resolveRoute('svc-7.apps.example.com', routes), 7);
});

test('resolveRoute still prefers an exact custom domain', () => {
  const routes = [
    { host: 'api.example.com', serviceId: 7 },
    { host: 'svc-7.apps.example.com', serviceId: 7 },
  ];
  assert.equal(resolveRoute('API.Example.com', routes), 7, 'host matching is case-insensitive');
  assert.equal(resolveRoute('svc-7.apps.example.com:443', routes), 7, 'port is stripped');
  assert.equal(resolveRoute('nope.example.com', routes), null);
});
