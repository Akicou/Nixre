#!/usr/bin/env node
// Opt in: node scripts/test-docker-upgrade.mjs --run
// Requires Docker and Node >=22. Only the outer, disposable DinD is privileged.
// No host socket, production compose, environment file, or production data is used.
// Logs/allowlisted build snapshots remain in --temp-root (default: OS temp/opencode).
// --socket-gid selects the nested socket group for the full stack (default 1999).
// Every run first regression-tests stock entrypoint socket GIDs and overrides.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

if (!process.argv.includes('--run')) {
  console.log('Skipped: opt in with node scripts/test-docker-upgrade.mjs --run');
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempArg = process.argv.indexOf('--temp-root');
const tempRoot = tempArg < 0 ? path.join(tmpdir(), 'opencode') : process.argv[tempArg + 1];
assert.ok(tempRoot && existsSync(tempRoot), 'Temp parent must already exist');
const prefix = `nixre-pr1-check-${randomBytes(6).toString('hex')}`;
const gidArg = process.argv.indexOf('--socket-gid');
const socketGid = gidArg < 0 ? '1999' : process.argv[gidArg + 1];
assert.match(socketGid || '', /^\d+$/);
const artifacts = mkdtempSync(path.join(tempRoot, `${prefix}-`));
const daemon = `${prefix}-dind`;
const outerNetwork = `${prefix}-outer`;
const storage = `${prefix}-docker`;
const secrets = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
const redact = text => secrets.reduce((s, value) => s.replaceAll(value, '[fixture-secret]'), String(text));
const report = { prefix, artifacts, socketGid, checks: [], resources: {}, stockStartup: false, cleanup: false };
let sequence = 0;
let outerCreated = false;
let networkCreated = false;
let volumeCreated = false;
function docker(args, { allowFailure = false, input, timeout = 900_000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, timeout, maxBuffer: 64 * 1024 * 1024 });
  const output = redact((result.stdout || '') + (result.stderr || ''));
  writeFileSync(path.join(artifacts, `${String(++sequence).padStart(3, '0')}.log`), output);
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`Docker operation ${sequence} failed: ${redact(result.error?.message || output).slice(-2500)}`);
  }
  return { ok: !result.error && result.status === 0, text: result.stdout?.trim() || '', output };
}
// All inner lifecycle operations are forced through this daemon's Unix socket.
const inner = (args, opts) => docker(['exec', '-i', daemon, 'docker', '--host', 'unix:///var/run/docker.sock', ...args], opts);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(check, description, attempts = 90) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await pause(1000);
  }
  throw new Error(`Timed out: ${description}`);
}
function pass(name) { report.checks.push(name); console.log(`PASS ${name}`); }
try {
  console.log(`Isolated test: ${prefix}\nArtifacts: ${artifacts}`);
  // Deliberate allowlist: never copy .env, data/, node_modules or agent settings.
  const context = path.join(artifacts, 'context');
  mkdirSync(path.join(context, 'backend'), { recursive: true });
  for (const name of ['Dockerfile', 'package.json', 'package-lock.json', 'entrypoint.sh', 'src', 'agent-sandbox']) {
    cpSync(path.join(root, 'backend', name), path.join(context, 'backend', name), { recursive: true });
  }
  cpSync(path.join(root, 'ui', 'dist'), path.join(context, 'dist'), { recursive: true });
  cpSync(path.join(root, 'Caddyfile'), path.join(context, 'Caddyfile'));
  cpSync(path.join(root, 'scripts', 'test-docker-upgrade-inner.mjs'), path.join(context, 'checks.mjs'));
  cpSync(path.join(root, 'scripts', 'updater'), path.join(context, 'updater'), { recursive: true });
  cpSync(path.join(root, 'scripts', 'test-instance-updater-inner.mjs'), path.join(context, 'updater-checks.mjs'));
  mkdirSync(path.join(context, 'ui'), { recursive: true });
  for (const name of readdirSync(path.join(root, 'ui')).filter(name =>
    ['src', 'public', 'dist', 'package.json', 'package-lock.json', 'index.html'].includes(name) || /^(?:tsconfig|vite\.config|postcss\.config|tailwind\.config)/.test(name))) {
    cpSync(path.join(root, 'ui', name), path.join(context, 'ui', name), { recursive: true });
  }
  writeFileSync(path.join(context, 'Worker.Dockerfile'), 'FROM nixre-upgrade-core:test\nUSER root\nRUN apk add --no-cache docker-cli docker-cli-compose\nENTRYPOINT ["node"]\n');
  report.entrypointCRLF = readFileSync(path.join(context, 'backend', 'entrypoint.sh')).includes(Buffer.from('\r\n'));
  report.resources.network = docker(['network', 'create', '--label', `nixre.upgrade-check=${prefix}`, outerNetwork]).text;
  networkCreated = true;
  docker(['volume', 'create', '--label', `nixre.upgrade-check=${prefix}`, storage]);
  volumeCreated = true;
  report.resources.daemon = docker(['run', '-d', '--privileged', '--name', daemon, '--hostname', daemon,
    '--label', `nixre.upgrade-check=${prefix}`, '--network', outerNetwork,
    '-e', 'DOCKER_TLS_CERTDIR=', '-v', `${storage}:/var/lib/docker`, 'docker:29-dind',
    'dockerd', '--host=unix:///var/run/docker.sock', `--group=${socketGid}`]).text;
  outerCreated = true;
  await wait(() => inner(['info', '--format', '{{.ID}}'], { allowFailure: true }).ok, 'DinD readiness');
  const outerInfo = JSON.parse(docker(['inspect', daemon]).text)[0];
  assert.deepEqual(Object.keys(outerInfo.NetworkSettings.Networks), [outerNetwork]);
  assert.equal(Object.keys(outerInfo.HostConfig.PortBindings || {}).length, 0);
  assert.ok(outerInfo.Mounts.every(m => m.Type === 'volume' && m.Name === storage));
  pass('outer daemon has only its dedicated network/volume and no published ports or host socket');
  docker(['cp', `${context}/.`, `${daemon}:/check`]);
  console.log('Building unchanged backend Dockerfile with its locked npm ci install...');
  inner(['build', '-t', 'nixre-upgrade-core:test', '/check/backend']);
  report.resources.coreImage = inner(['image', 'inspect', '-f', '{{.Id}}', 'nixre-upgrade-core:test']).text;
  pass('actual node:22-alpine backend Dockerfile / npm ci --omit=dev build');
  const pingProbe = `
    const assert = require('node:assert/strict');
    assert.equal(process.getuid(), 1000);
    assert.equal(process.getgid(), Number(process.argv[1]));
    const expected = process.argv[2];
    const req = require('node:http').get({ socketPath: '/var/run/docker.sock', path: '/_ping' }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        assert.equal(expected, 'OK');
        assert.equal(res.statusCode, 200);
        assert.equal(body, 'OK');
        console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), ping: body }));
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Docker ping timed out')));
    req.on('error', err => {
      assert.equal(expected, 'EACCES');
      assert.equal(err.code, expected);
      console.log(JSON.stringify({ uid: process.getuid(), gid: process.getgid(), ping: err.code }));
    });`;
  try {
    for (const [gid, override, expected] of [
      ['0', null, 'OK'], ['1000', null, 'OK'], ['1999', null, 'OK'],
      ['0', '0', 'OK'], ['1000', '1000', 'OK'], ['1999', '1000', 'EACCES'],
    ]) {
      // This is the nested daemon's socket, never a host-daemon bind mount.
      docker(['exec', '--user', '0', daemon, 'chown', `0:${gid}`, '/var/run/docker.sock']);
      const probe = inner(['run', '--rm', '--network', 'none', '-v', '/var/run/docker.sock:/var/run/docker.sock',
        ...(override === null ? [] : ['-e', `DOCKER_GID=${override}`]),
        'nixre-upgrade-core:test', 'node', '-e', pingProbe, override ?? gid, expected]);
      assert.equal(JSON.parse(probe.text).ping, expected);
      pass(`stock entrypoint UID 1000, socket GID ${gid}, override ${override ?? 'unset'}, Docker _ping ${expected}`);
    }
    const invalid = inner(['run', '--rm', '--network', 'none', '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-e', 'DOCKER_GID=not-a-gid', 'nixre-upgrade-core:test', 'node', '-e', "console.log('UNEXPECTED_COMMAND_EXECUTION')"], { allowFailure: true });
    assert.equal(invalid.ok, false);
    assert.match(invalid.output, /Docker socket group must be a numeric GID/);
    assert.doesNotMatch(invalid.output, /UNEXPECTED_COMMAND_EXECUTION/);
    pass('stock entrypoint rejects invalid DOCKER_GID before executing the command');
  } finally {
    docker(['exec', '--user', '0', daemon, 'chown', `0:${socketGid}`, '/var/run/docker.sock']);
  }
  for (const image of ['postgres:16-alpine', 'caddy:2-alpine', 'nginx:stable-alpine']) inner(['pull', image]);
  for (const name of ['default', 'apps', 'old']) inner(['network', 'create', `${prefix}-${name}`]);
  inner(['network', 'create', '--internal', `${prefix}_nixre-data`]);
  inner(['run', '-d', '--name', 'check-db', '--network', `${prefix}_nixre-data`,
    '-e', 'POSTGRES_USER=fixture', '-e', `POSTGRES_PASSWORD=${secrets[0]}`, '-e', 'POSTGRES_DB=fixture', 'postgres:16-alpine']);
  await wait(() => inner(['exec', 'check-db', 'pg_isready', '-U', 'fixture'], { allowFailure: true }).ok, 'fixture Postgres');
  const coreEnv = { PGHOST: 'check-db', PGUSER: 'fixture', PGDATABASE: 'fixture', PGPASSWORD: secrets[0],
    INTERNAL_TOKEN: secrets[1], AI_SECRET: secrets[2], REPOS_ROOT: '/data/repos',
    NIXRE_REGISTRATION_CLOSED: 'false', NIXRE_APPS_NETWORK: `${prefix}-apps`,
    NIXRE_DATA_NETWORK: `${prefix}_nixre-data`, SANDBOX_NETWORK: `${prefix}-default`,
    SANDBOX_IMAGE: 'nixre-upgrade-sandbox:test', CORE_URL: 'http://nixre-core:3002',
    SANDBOX_SWEEP_MS: '3600000', SANDBOX_CMD_MS: '15000', DEPLOY_SWEEP_MS: '3600000', CHECK_PREFIX: prefix };
  const coreArgs = ['create', '--name', 'check-core', '--network', `${prefix}-default`, '--network-alias', 'nixre-core',
    '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', 'check-repos:/data/repos',
    ...Object.entries(coreEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`])];
  async function startCore() {
    inner([...coreArgs, 'nixre-upgrade-core:test']);
    for (const net of [`${prefix}-apps`, `${prefix}_nixre-data`]) inner(['network', 'connect', net, 'check-core']);
    inner(['start', 'check-core']);
    for (let i = 0; i < 45; i++) {
      if (inner(['exec', 'check-core', 'node', '-e', "fetch('http://127.0.0.1:3002/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { allowFailure: true }).ok) return true;
      if (inner(['inspect', '-f', '{{.State.Running}}', 'check-core']).text !== 'true') return false;
      await pause(1000);
    }
    return false;
  }
  report.stockStartup = await startCore();
  if (!report.stockStartup) {
    const logs = inner(['logs', 'check-core'], { allowFailure: true });
    writeFileSync(path.join(artifacts, 'stock-startup.log'), logs.output);
    console.log(`FAIL stock image startup (CRLF source: ${report.entrypointCRLF}); see stock-startup.log`);
    throw new Error('Actual image startup failed');
  } else pass('actual image entrypoint startup and /healthz');
  const expectedMigrations = readdirSync(path.join(context, 'backend', 'src', 'db', 'migrations'))
    .filter(file => file.endsWith('.sql')).sort();
  const appliedMigrations = inner(['exec', 'check-db', 'psql', '-U', 'fixture', '-d', 'fixture', '-Atc',
    'SELECT version FROM schema_migrations']).text.split('\n').filter(Boolean).sort();
  assert.deepEqual(appliedMigrations, expectedMigrations, 'every bundled migration is applied exactly once');
  pass(`all ${expectedMigrations.length} migrations applied to real Postgres`);
  console.log('Building the unchanged sandbox Dockerfile (includes Chromium)...');
  inner(['build', '-t', 'nixre-upgrade-sandbox:test', '/check/backend/agent-sandbox']);
  report.resources.sandboxImage = inner(['image', 'inspect', '-f', '{{.Id}}', 'nixre-upgrade-sandbox:test']).text;
  pass('actual sandbox Dockerfile build');
  inner(['run', '-d', '--name', 'check-web', '--network', `${prefix}-default`,
    '-v', '/check/dist:/usr/share/caddy:ro', '-v', '/check/Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy:2-alpine']);
  inner(['cp', '/check/checks.mjs', 'check-core:/tmp/checks.mjs']);
  const tests = inner(['exec', '--user', `1000:${socketGid}`, 'check-core', 'node', '/tmp/checks.mjs'], { timeout: 300_000 });
  console.log(tests.text);
  report.checks.push(...tests.text.split('\n').filter(line => line.startsWith('PASS ')).map(line => line.slice(5)));
  writeFileSync(path.join(artifacts, 'integration.log'), tests.output);
  pass('real API, app reconciliation, capability policy and sandbox checks');
  inner(['build', '-f', '/check/Worker.Dockerfile', '-t', 'nixre-upgrade-worker:test', '/check']);
  const updaterChecks = inner(['run', '--rm', '--name', 'check-updater', '--network', 'host',
    '-e', `CHECK_PREFIX=${prefix}`, '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', '/check:/check',
    'nixre-upgrade-worker:test', '/check/updater-checks.mjs'], { timeout: 1_500_000 });
  console.log(updaterChecks.text);
  pass('real host updater success, migration-rehearsal rejection, and post-commit recovery with independent status');
} catch (err) {
  report.error = redact(err.stack || err);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (outerCreated) {
    const workerLogs = docker(['exec', daemon, 'find', '/check/update-fixture/data/updater', '-maxdepth', '1', '-name', '*.log'], { allowFailure: true });
    for (const filename of workerLogs.text.split('\n').filter(name => /^\/check\/update-fixture\/data\/updater\/[a-z0-9-]+\.log$/.test(name))) {
      docker(['cp', `${daemon}:${filename}`, path.join(artifacts, `updater-${path.basename(filename)}`)], { allowFailure: true });
    }
    report.innerContainers = inner(['ps', '-a', '--format', '{{.ID}} {{.Names}}'], { allowFailure: true }).text.split('\n').filter(Boolean);
    report.innerVolumes = inner(['volume', 'ls', '--format', '{{.Name}}'], { allowFailure: true }).text.split('\n').filter(Boolean);
    const list = inner(['ps', '-aq'], { allowFailure: true });
    if (list.ok) {
      report.innerContainerIds = list.text.split(/\s+/).filter(Boolean);
      for (const id of report.innerContainerIds) {
        const logs = inner(['logs', id], { allowFailure: true });
        writeFileSync(path.join(artifacts, `container-${id}.log`), logs.output);
      }
    }
    docker(['logs', daemon], { allowFailure: true });
    docker(['rm', '-f', '-v', daemon], { allowFailure: true });
  }
  if (volumeCreated) docker(['volume', 'rm', storage], { allowFailure: true });
  if (networkCreated) docker(['network', 'rm', outerNetwork], { allowFailure: true });
  const leftovers = [
    docker(['ps', '-aq', '--filter', `label=nixre.upgrade-check=${prefix}`]),
    docker(['network', 'ls', '-q', '--filter', `label=nixre.upgrade-check=${prefix}`]),
    docker(['volume', 'ls', '-q', '--filter', `label=nixre.upgrade-check=${prefix}`]),
  ];
  report.cleanup = leftovers.every(r => r.text === '');
  if (!report.cleanup) { console.error('FAIL cleanup: test resources remain'); process.exitCode = 1; }
  writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Cleanup ${report.cleanup ? 'verified' : 'FAILED'} for ${prefix}; report: ${path.join(artifacts, 'report.json')}`);
}
