import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { executeUpdate, recoverInterrupted } from '../../../scripts/updater/engine.mjs';
import { createUpdater } from '../../../scripts/updater/server.mjs';
import { HostDriver, assertUpgrade, assertDatabaseConfiguration } from '../../../scripts/updater/driver.mjs';
import { updateRoutes } from '../routes/updates.js';
import { updateMaintenance } from '../lib/instanceUpdater.js';

const base = 'a'.repeat(40), target = 'b'.repeat(40);
function fixture(failAt, rollbackConfirmed) {
  const calls = [], snapshots = [];
  const driver = Object.fromEntries(['preflight', 'build', 'backup', 'rehearse', 'guard', 'stop', 'migrate', 'activate', 'health', 'publish', 'resumeOld', 'cleanup'].map(name => [name, async (...args) => {
    const label = name === 'backup' ? `${name}:${args[1]}` : name;
    calls.push(label);
    if (label === failAt) throw Object.assign(new Error(`Failed ${label}`), { rollbackConfirmed });
    if (name === 'preflight') return { oldImage: 'previous' };
    if (name === 'backup') return `/private/${args[1]}.dump`;
    if (name === 'migrate') return ['027_example.sql'];
  }]));
  const job = { plan: { base, target }, steps: [], status: 'running' };
  return { driver, job, calls, snapshots, save: async () => { snapshots.push(structuredClone(job)); } };
}

test('update failure boundaries keep production unchanged before migrations', async t => {
  for (const stage of ['preflight', 'build', 'backup:rehearsal', 'rehearse', 'guard', 'backup:final']) {
    await t.test(stage, async () => {
      const f = fixture(stage);
      await executeUpdate(f.driver, f.job, f.save);
      assert.equal(f.job.status, 'failed');
      assert.ok(!f.calls.includes('migrate'));
      assert.ok(!f.calls.includes('publish'));
      assert.equal(f.calls.includes('resumeOld'), stage === 'backup:final');
    });
  }
});
test('only an explicitly confirmed migration rollback permits old services to restart', async () => {
  const f = fixture('migrate', true);
  await executeUpdate(f.driver, f.job, f.save);
  assert.equal(f.job.database, 'unchanged');
  assert.equal(f.job.status, 'failed');
  assert.ok(f.calls.includes('resumeOld'));
  assert.ok(!f.calls.includes('activate'));
  assert.ok(f.snapshots.some(job => job.database === 'uncertain'), 'persist the ambiguous boundary before starting SQL');
});
test('uncertain commit, failed health, and failed UI publication require operator recovery', async t => {
  for (const stage of ['migrate', 'health', 'publish']) await t.test(stage, async () => {
    const f = fixture(stage, false);
    await executeUpdate(f.driver, f.job, f.save);
    assert.equal(f.job.status, 'recovery_required');
    assert.ok(!f.calls.includes('resumeOld'), 'never start old code against uncertain/new schema');
    assert.equal(f.calls.filter(call => call === 'stop').length, 2);
    assert.equal(f.job.backup, '/private/final.dump');
  });
});
test('successful cutover verifies health before publishing, retaining the final backup', async () => {
  const f = fixture();
  await executeUpdate(f.driver, f.job, f.save);
  assert.equal(f.job.status, 'succeeded');
  assert.equal(f.job.database, 'committed');
  assert.ok(f.calls.indexOf('health') < f.calls.indexOf('publish'));
  assert.equal(f.job.backup, '/private/final.dump');
  assert.equal(recoverInterrupted({ status: 'running', database: 'uncertain' }).status, 'recovery_required');
  assert.equal(recoverInterrupted({ status: 'checking' }).status, 'recovery_required');
});
test('terminal recovery is not published while candidate services are still stopping', async () => {
  const f = fixture('health');
  let stopCount = 0, releaseStop;
  f.driver.stop = async () => {
    if (++stopCount === 2) await new Promise(resolve => { releaseStop = resolve; });
  };
  const running = executeUpdate(f.driver, f.job, f.save);
  await until(() => !!releaseStop);
  assert.equal(f.job.status, 'running');
  assert.equal(f.job.finishedAt, undefined);
  releaseStop();
  await running;
  assert.equal(f.job.status, 'recovery_required');
  assert.ok(f.job.finishedAt);
});
test('automatic update policy refuses infrastructure changes and historical migration edits', () => {
  for (const filename of ['Caddyfile', 'docker-compose.yml', 'ssh/Dockerfile', 'scripts/updater/engine.mjs', 'backend/entrypoint.sh']) {
    assert.throws(() => assertUpgrade(base, target, [{ status: 'M', path: filename }]), /manual upgrade/);
  }
  assert.throws(() => assertUpgrade(base, target, [{ status: 'M', path: 'backend/src/db/migrations/001_init.sql' }]), /Existing migrations/);
  assert.doesNotThrow(() => assertUpgrade(base, target, [{ status: 'A', path: 'backend/src/db/migrations/028_new.sql' }]));
});
test('CI gate binds to the latest push run of the exact reviewed main revision', async () => {
  const passed = { id: 1, head_sha: target, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/run' };
  let runs = [passed];
  const driver = new HostDriver({ root: '/tmp', stateDir: '/tmp', logFile: '/tmp/unused', fetchImpl: async () => ({ ok: true, json: async () => ({ workflow_runs: runs }) }) });
  assert.equal(await driver.checkCI(target), passed.html_url);
  for (const replacement of [{ ...passed, head_sha: base }, { ...passed, event: 'pull_request' }, { ...passed, head_branch: 'other' },
    { ...passed, id: 2, conclusion: 'failure' }, { ...passed, id: 2, status: 'in_progress', conclusion: null }]) {
    runs = replacement.id === 2 ? [passed, replacement] : [replacement];
    await assert.rejects(driver.checkCI(target), /has not passed/);
  }
});
test('database safety gate rejects external URLs and backup / migration target mismatches', () => {
  const config = { services: { 'nixre-core': { environment: { PGHOST: 'nixre-db', PGUSER: 'u', PGDATABASE: 'db', PGPASSWORD: 'fixture' } },
    'nixre-db': { environment: { POSTGRES_USER: 'u', POSTGRES_DB: 'db', POSTGRES_PASSWORD: 'fixture' } } } };
  assert.doesNotThrow(() => assertDatabaseConfiguration(config));
  for (const override of [{ DATABASE_URL: 'postgres://external' }, { PGHOST: 'external' }, { PGDATABASE: 'another' }, { PGPASSWORD: 'different' }, { PGPORT: '5433' }]) {
    const invalid = structuredClone(config);
    Object.assign(invalid.services['nixre-core'].environment, override);
    assert.throws(() => assertDatabaseConfiguration(invalid), /manual upgrade/);
  }
});
test('command failure output stays in the private log, not the returned error', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'nixre-worker-log-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const logFile = path.join(folder, 'private.log');
  const driver = new HostDriver({ root: folder, stateDir: folder, logFile });
  await assert.rejects(driver.run(process.execPath, ['-e', "console.error('fixture-secret');process.exit(1)"]), error => {
    assert.doesNotMatch(error.message, /fixture-secret/); return true;
  });
  assert.match(await readFile(logFile, 'utf8'), /fixture-secret/);
});

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition did not settle');
}
test('worker authorization, idempotency, concurrent update exclusion, and independent observation', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'nixre-worker-api-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const key = 'control-'.repeat(10);
  let finishPlan;
  const plan = { id: randomUUID(), base, target, available: true, createdAt: Date.now() };
  const servers = await createUpdater({ root: folder, stateDir: folder, key,
    driverFactory: () => ({ plan: () => new Promise(resolve => { finishPlan = () => resolve(plan); }) }) });
  const controlUrl = await listen(servers.control, t), publicUrl = await listen(servers.status, t);
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(controlUrl + '/state')).status, 401);
  assert.equal((await fetch(publicUrl + '/apply', { method: 'POST', headers })).status, 404);
  const id = randomUUID();
  const request = () => fetch(controlUrl + '/check', { method: 'POST', headers, body: JSON.stringify({ requestId: id, actor: 'admin' }) });
  const started = await (await request()).json();
  assert.equal(started.current.status, 'checking');
  assert.equal((await request()).status, 200, 'same request does not start a duplicate');
  assert.equal((await fetch(controlUrl + '/check', { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), actor: 'admin' }) })).status, 409);
  assert.equal((await fetch(controlUrl + '/shutdown', { method: 'POST', headers })).status, 409, 'installer cannot interrupt work');
  assert.equal((await fetch(publicUrl + '/update-status/current', { headers })).status, 401, 'control secret is not a public observation token');
  const observerHeaders = { Authorization: `Bearer ${started.watchToken}` };
  assert.equal((await fetch(publicUrl + '/update-status/current', { headers: observerHeaders })).status, 200);
  assert.equal((await fetch(publicUrl + '/update-status/current', { headers: { Authorization: `Bearer ${started.watchToken}x` } })).status, 401);
  finishPlan();
  await until(async () => (await (await fetch(controlUrl + '/state', { headers })).json()).current.status === 'checked');
  assert.equal((await fetch(controlUrl + '/apply', { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), actor: 'admin', planId: plan.id, target: base, expectedBase: base }) })).status, 409);
  // A visible "checked" state precedes its final durable save. Wait until the
  // worker accepts review validation (rather than reporting an active update)
  // before teardown can remove the state directory under that final write.
  await until(async () => {
    const response = await fetch(controlUrl + '/apply', { method: 'POST', headers,
      body: JSON.stringify({ requestId: randomUUID(), actor: 'admin', planId: plan.id, target: base, expectedBase: base }) });
    return (await response.json()).message === 'Update review no longer matches. Check for updates again.';
  });
  // Stop the control connection entirely: observers need no core or control API.
  servers.control.closeAllConnections(); servers.control.close();
  const observed = await (await fetch(publicUrl + '/update-status/current', { headers: observerHeaders })).json();
  assert.equal(observed.status, 'checked');
  assert.ok(!JSON.stringify(observed).includes(key));
});
test('restart preserves interrupted outcomes and blocks replay', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'nixre-worker-restart-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(path.join(folder, 'state.json'), JSON.stringify({ jobs: [{ id: randomUUID(), status: 'running', database: 'uncertain' }] }));
  const key = 'private-'.repeat(8);
  const servers = await createUpdater({ root: folder, stateDir: folder, key });
  const url = await listen(servers.control, t);
  const headers = { Authorization: `Bearer ${key}` };
  const state = await (await fetch(url + '/state', { headers })).json();
  assert.equal(state.current.status, 'recovery_required');
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'data/update-control/maintenance.json'), 'utf8')), { recoveryRequired: true });
  assert.equal((await fetch(url + '/check', { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), actor: 'admin' }) })).status, 409);
});
test('admin update API rejects ordinary users and PATs and forwards only approved fields', async t => {
  let auth = { user: { uid: 'admin', admin: true }, kind: 'session' };
  const forwarded = [];
  const app = express(); app.use(express.json());
  app.use(updateRoutes(() => (req, _res, next) => { req.auth = auth; next(); }, async (...args) => { forwarded.push(args); return { enabled: true }; }));
  const url = await listen(createServer(app), t);
  for (const value of [{ user: { admin: false }, kind: 'session' }, { user: { admin: true }, kind: 'pat' }, { user: { admin: true, blocked: true }, kind: 'session' }]) {
    auth = value;
    assert.equal((await fetch(url + '/admin/updates')).status, 403);
  }
  assert.equal(forwarded.length, 0);
  auth = { user: { uid: 'admin', admin: true }, kind: 'session' };
  const requestId = randomUUID();
  assert.equal((await fetch(url + '/admin/updates/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, planId: 'plan', expectedBase: base, target, command: 'BAD', actor: 'forged' }) })).status, 202);
  assert.deepEqual(forwarded[0], ['/apply', { requestId, planId: 'plan', expectedBase: base, target, actor: 'admin' }]);
});
test('maintenance pauses HTTP mutations and Git push while allowing reads', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'nixre-maintenance-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const app = express(); app.use(updateMaintenance(folder)); app.use((_req, res) => res.json({ ok: true }));
  const url = await listen(createServer(app), t);
  assert.equal((await fetch(url + '/api/v1/repos', { method: 'POST' })).status, 200);
  await writeFile(path.join(folder, 'maintenance.json'), '{}');
  assert.equal((await fetch(url + '/api/v1/admin/updates')).status, 200);
  for (const route of ['/api/v1/repos', '/git/owner/repo.git/git-receive-pack']) {
    const result = await fetch(url + route, { method: 'POST' });
    assert.equal(result.status, 503); assert.equal(result.headers.get('Retry-After'), '30');
  }
});
