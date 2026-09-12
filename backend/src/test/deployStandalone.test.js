import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import express from 'express';
import pg from 'pg';
import { deploymentRoutes } from '../routes/deployments.js';
import { encryptSecret, decryptSecret } from '../lib/ai.js';

const base = '/spaces/dev/deployments/services';
const image = { name: 'worker', source_type: 'image', image_ref: 'alpine:3.21' };
const git = { name: 'llama', source_type: 'git', git_url: 'https://github.com/ggml-org/llama.cpp.git', branch: 'master', dockerfile_path: '.devops/server.Dockerfile', build_target: 'server' };

async function fixture(t) {
  const previous = process.env.AI_SECRET;
  process.env.AI_SECRET = randomBytes(32).toString('hex');
  t.after(() => { if (previous === undefined) delete process.env.AI_SECRET; else process.env.AI_SECRET = previous; });
  const user = { uid: 'dev', admin: false, blocked: false };
  const spaces = [{ uid: 'dev', is_public: true }, { uid: 'other', is_public: false }];
  const repos = [{ id: 7, uid: 'private', space_uid: 'dev', is_public: false, default_branch: 'main' },
    { id: 8, uid: 'public', space_uid: 'dev', is_public: true, default_branch: 'main' }];
  const services = [7, 8].map((id, i) => ({ id: i + 1, repo_id: id, space_uid: null, name: `legacy-${id}`, source_type: 'repo',
    exposure: 'http', deployment_strategy: 'blue_green', auto_deploy: true, runtime_options: { version: 1 },
    security_policy_version: 1, current_deployment_id: null, desired_state: 'running' }));
  const vars = [{ service_id: 1, key: 'KEEP', value_enc: encryptSecret('original'), updated: 1 }];
  const deployments = [{ id: 10, service_id: 1, sha: 'abc', status: 'live' }, { id: 20, service_id: 2, status: 'live' }];
  const domains = [{ id: 10, service_id: 1, domain: 'private.example.com', verified: true }];
  const writes = [], queries = [], calls = [];
  const state = { failEnv: false, stopError: null, stopGate: null, stopEntered: null };
  let snapshot;
  const pool = {
    async connect() { return { query: pool.query, release() {} }; },
    async query(sql, params = []) {
      sql = sql.trim();
      queries.push({ sql, params });
      if (sql === 'BEGIN') { snapshot = structuredClone({ services, vars }); return { rows: [] }; }
      if (sql === 'COMMIT') { snapshot = null; return { rows: [] }; }
      if (sql === 'ROLLBACK') {
        services.splice(0, services.length, ...snapshot.services);
        vars.splice(0, vars.length, ...snapshot.vars);
        snapshot = null;
        return { rows: [] };
      }
      if (sql.includes('FROM space_members')) return { rows: params[1] === 'dev' && params[0] === 'dev' ? [{ member: true }] : [] };
      if (sql.includes('FROM spaces')) return { rows: spaces.filter(s => s.uid === params[0]) };
      if (sql.includes('FROM repos')) return { rows: sql.includes('space_uid =')
        ? repos.filter(r => r.space_uid === params[0] && r.uid === params[1]) : repos.filter(r => r.id === params[0]) };
      if (sql.startsWith('INSERT INTO deploy_services')) {
        const keys = sql.match(/deploy_services \(([^)]+)\)/)[1].split(',').map(k => k.trim());
        const row = { id: Math.max(...services.map(s => s.id), 0) + 1, security_policy_version: 2,
          desired_state: 'running', status: 'idle', current_deployment_id: null, ...Object.fromEntries(keys.map((k, i) => [k, params[i]])) };
        if (services.some(s => s.name === row.name && (row.repo_id === null ? s.repo_id === null && s.space_uid === row.space_uid : s.repo_id === row.repo_id))) throw Object.assign(new Error('duplicate'), { code: '23505' });
        services.push(row); writes.push(sql); return { rows: [row] };
      }
      if (sql.startsWith('UPDATE deploy_services SET')) {
        const row = services.find(s => s.id === params.at(-1));
        const keys = sql.slice(sql.indexOf('SET ') + 4, sql.lastIndexOf('WHERE')).split(',').map(k => k.trim().split(' ')[0]);
        keys.forEach((key, i) => { row[key] = params[i]; });
        writes.push(sql); return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM deploy_services')) {
        services.splice(services.findIndex(s => s.id === params[0]), 1); writes.push(sql); return { rows: [] };
      }
      if (sql.includes('FROM deploy_services')) {
        let rows = services.map(s => {
          const repo = repos.find(r => r.id === s.repo_id) || null;
          return sql.includes('LEFT JOIN repos') ? { ...s, space_uid: s.space_uid ?? repo?.space_uid, repo, repo_uid: repo?.uid } : s;
        });
        if (sql.includes('count(*)')) {
          rows = rows.filter(s => sql.includes('repo_id IS NULL') ? s.repo_id === null && s.space_uid === params[0] : s.repo_id === params[0]);
          return { rows: [{ n: rows.length }] };
        }
        if (sql.includes('WHERE s.id =')) rows = rows.filter(s => s.id === params[0] && s.space_uid === params[1]);
        else if (sql.includes('WHERE id =')) rows = rows.filter(s => s.id === params[0] && (params.length === 1 || s.repo_id === params[1]));
        else if (sql.includes('WHERE repo_id =')) rows = rows.filter(s => s.repo_id === params[0]);
        else if (sql.includes('WHERE COALESCE')) rows = rows.filter(s => s.space_uid === params[0]);
        return { rows };
      }
      if (sql.startsWith('INSERT INTO service_env_vars')) {
        if (state.failEnv) throw Object.assign(new Error('env storage unavailable'), { status: 503 });
        const row = { service_id: params[0], key: params[1], value_enc: params[2], updated: params[3] };
        const old = vars.find(v => v.service_id === row.service_id && v.key === row.key);
        if (old) Object.assign(old, row); else vars.push(row);
        writes.push(sql); return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM service_env_vars')) {
        for (let i = vars.length - 1; i >= 0; i--) if (vars[i].service_id === params[0] && (params.length < 2 || vars[i].key === params[1])
          && (!sql.includes('NOT IN') || !['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'].includes(vars[i].key))) vars.splice(i, 1);
        writes.push(sql); return { rows: [] };
      }
      if (sql.includes('FROM service_env_vars')) return { rows: vars.filter(v => v.service_id === params[0] && (params.length < 2 || v.key === params[1])) };
      if (sql.includes('FROM deployments')) return { rows: sql.includes('WHERE id =')
        ? deployments.filter(d => d.id === params[0] && d.service_id === params[1])
        : deployments.filter(d => sql.includes('IN (') ? params.includes(d.service_id) : d.service_id === params[0]) };
      if (sql.includes('FROM deploy_domains')) return { rows: sql.includes('WHERE id =')
        ? domains.filter(d => d.id === params[0] && d.service_id === params[1])
        : domains.filter(d => sql.includes('IN (') ? params.includes(d.service_id) : d.service_id === params[0]) };
      if (sql.includes('FROM deploy_http_logs') || sql.includes('FROM deploy_uptime_checks')) return { rows: [] };
      throw new Error(`Unhandled fixture SQL: ${sql}`);
    },
  };
  const engine = {
    async stopService(id) {
      calls.push(['stop', id]); state.stopEntered?.();
      await state.stopGate;
      if (state.stopError) throw state.stopError;
      services.find(s => s.id === id).desired_state = 'stopped';
    },
    async startService(id) { calls.push(['start', id]); },
    async startDeployment(id, options) { calls.push(['deploy', id, options]); return { id: 99 }; },
    async runtimeLogs(id, options) { calls.push(['logs', id, options]); return 'runtime output'; },
    getStatsSnapshot() { return { latest: null, series: [] }; },
    async cancelDeployment(id) { calls.push(['cancel', id]); return true; },
    async redeploy(id, depId) { calls.push(['redeploy', id, depId]); return { id: 99 }; },
    async rollback(id, depId) { calls.push(['rollback', id, depId]); return { id: 99 }; },
    async deleteDeployment(id, depId) { calls.push(['deleteDeployment', id, depId]); },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { user }; next(); });
  app.use(deploymentRoutes(pool, () => (_req, _res, next) => next(), {
    engine, listTree: async () => { calls.push(['tree']); return ['Dockerfile']; },
    proxy: () => ({ invalidateRoutes() {} }), env: { NIXRE_DEPLOY_BIND_ALLOWLIST: '/models', NIXRE_DEPLOY_GIT_HOSTS: 'gitlab.com' },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  async function request(method, path = base, body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { user, services, vars, deployments, domains, writes, queries, calls, state, request };
}

test('standalone Git/image creation is transactional, explicit, private and does not fetch/deploy', async t => {
  const f = await fixture(t);
  const before = structuredClone(f.services);
  const secret = f.vars[0].value_enc;
  for (const input of [git, { ...image, volume_path: '/data', env: { TOKEN: 'test-only-secret' } }]) {
    const created = await f.request('POST', base, input);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.space_uid, 'dev');
    assert.equal(created.body.repo_id, null);
    assert.equal(created.body.exposure, 'internal');
    assert.equal(created.body.deployment_strategy, 'recreate');
    assert.equal(created.body.auto_deploy, false);
    assert.equal(created.body.can_write, true);
    assert.equal(created.body.internal_hostname, `nixre-svc-${created.body.id}`);
    assert.equal(created.body.volume_name, input.volume_path ? `nixre-service-${created.body.id}-data` : null);
    assert.equal(JSON.stringify(created.body).includes('test-only-secret'), false);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.services.slice(0, 2), before);
  assert.equal(f.vars[0].value_enc, secret);
  assert.equal(decryptSecret(f.vars.find(v => v.key === 'TOKEN').value_enc), 'test-only-secret');
  assert.equal((await f.request('POST', base, git)).status, 409);
  assert.equal(f.queries.filter(q => q.sql === 'COMMIT').length, 2);
  const legacy = await f.request('POST', '/repos/dev/private/+/deployments/services', { name: 'old-create', dockerfile_path: 'Dockerfile' });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.body.source_type, 'repo');
  assert.equal(legacy.body.repo_id, 7);
  assert.equal(legacy.body.space_uid, 'dev');
  assert.equal(legacy.body.exposure, 'http');
  assert.equal(legacy.body.deployment_strategy, 'blue_green');
  assert.equal(legacy.body.internal_hostname, null);
});

test('standalone services require recreate while repo blue/green never advertises a stable hostname', async t => {
  const f = await fixture(t);
  for (const input of [git, image]) {
    assert.equal((await f.request('POST', base, { ...input, deployment_strategy: 'blue_green', env: { MUST_NOT_WRITE: 'x' } })).status, 400);
    const { body: s, status } = await f.request('POST', base, input);
    assert.equal(status, 201);
    const writes = f.writes.length;
    assert.equal((await f.request('PATCH', `${base}/${s.id}`, { env: { MUST_NOT_WRITE: 'x' }, deployment_strategy: 'blue_green' })).status, 400);
    assert.equal(f.writes.length, writes);
    assert.equal((await f.request('GET', `${base}/${s.id}`)).body.internal_hostname, `nixre-svc-${s.id}`);
  }
  assert.equal((await f.request('PATCH', `${base}/1`, { deployment_strategy: 'recreate' })).body.internal_hostname, 'nixre-svc-1');
  const legacy = await f.request('PATCH', '/repos/dev/private/+/deployments/services/1', { deployment_strategy: 'blue_green' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.deployment_strategy, 'blue_green');
  assert.equal(legacy.body.internal_hostname, null);
  for (const path of [base, '/repos/dev/private/+/deployments/services', '/deployments/overview']) {
    assert.equal((await f.request('GET', path)).body.find(s => s.id === 1).internal_hostname, null);
  }
  assert.equal((await f.request('GET', '/spaces/dev/deployments')).body.services.find(s => s.id === 1).internal_hostname, null);
  assert.deepEqual(f.calls, []);
});

test('Postgres provisions encrypted generated credentials and locks initialization/storage/runtime invariants', async t => {
  const f = await fixture(t);
  const created = await f.request('POST', base, { ...image, image_ref: 'postgres:17', template: 'postgres' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id } = created.body;
  assert.equal(created.body.container_port, 5432);
  assert.equal(created.body.volume_path, '/var/lib/postgresql/data');
  const initial = f.vars.filter(v => v.service_id === id);
  assert.deepEqual(initial.map(v => v.key).sort(), ['POSTGRES_DB', 'POSTGRES_PASSWORD', 'POSTGRES_USER']);
  const password = decryptSecret(initial.find(v => v.key === 'POSTGRES_PASSWORD').value_enc);
  assert.ok(password.length >= 40);
  assert.equal(JSON.stringify(created.body).includes(password), false);
  assert.equal(decryptSecret(initial.find(v => v.key === 'POSTGRES_DB').value_enc), 'app');
  assert.equal((await f.request('GET', `${base}/${id}/env/POSTGRES_PASSWORD/reveal`)).body.value, password);
  for (const body of [{ image_ref: 'postgres:16' }, { exposure: 'http' }, { volume_path: null }, { deployment_strategy: 'blue_green' },
    { runtime_options: null }, { container_port: 8080 }, { security_policy_version: 1 }, { template: null }, { env: { POSTGRES_PASSWORD: 'replacement' } }]) {
    assert.ok([400, 403].includes((await f.request('PATCH', `${base}/${id}`, body)).status), JSON.stringify(body));
  }
  assert.equal((await f.request('PUT', `${base}/${id}/env`, { vars: { POSTGRES_HOST_AUTH_METHOD: 'trust' } })).status, 400);
  assert.equal((await f.request('DELETE', `${base}/${id}/env/POSTGRES_PASSWORD`)).status, 400);
  assert.equal((await f.request('PUT', `${base}/${id}/env`, { vars: { TZ: 'UTC' } })).status, 200);
  assert.deepEqual(f.vars.filter(v => v.service_id === id && v.key.startsWith('POSTGRES_')), initial);
  assert.equal((await f.request('PATCH', `${base}/${id}`, { memory_mb: 1024 })).status, 200);
  for (const body of [{ image_ref: 'postgres:18' }, { username: 'app;DROP' }, { database: 'a'.repeat(64) }, { exposure: 'http' },
    { env: { POSTGRES_PASSWORD: 'caller-secret' } }, { env: { POSTGRES_HOST_AUTH_METHOD: 'trust' } }, { env: { PGDATA: '/tmp' } }, { runtime_options: {} }]) {
    assert.equal((await f.request('POST', base, { ...image, image_ref: 'postgres:17', template: 'postgres', ...body })).status, 400, JSON.stringify(body));
  }
});

test('malformed create/PATCH configs have no writes or lifecycle effects regardless of key order', async t => {
  const f = await fixture(t);
  const malformed = [{ cpu_cores: null }, { cpu_cores: 'Infinity' }, { cpu_cores: 0 }, { memory_mb: 1e100 }, { memory_mb: -1 },
    { container_port: 0 }, { container_port: 1.2 }, { auto_deploy: true }, { source_type: 'repo' }, { repo_id: 7 },
    { owner: 'other' }, { name: 'A'.repeat(50) }, { image_ref: 'https://user:password@registry.example/image' },
    { image_ref: '--privileged' }, { volume_path: '/' }, { volume_path: '/data/../etc' }, { volume_name: 'existing' },
    { exposure: 'tcp' }, { runtime_options: { HostConfig: { Privileged: true } } }, { runtime_options: [] },
    { runtime_options: { host_config: 'privileged' } }, { runtime_options: { host_config: [] } },
    { runtime_options: { host_config: { gpus: 'all' } } }, { env: { 'BAD-KEY': 'x' } }, { env: { KEY: {} } }];
  for (const bad of malformed) assert.equal((await f.request('POST', base, { ...image, ...bad })).status, 400, JSON.stringify(bad));
  for (const bad of [{ git_url: 'http://github.com/org/repo' }, { git_url: 'https://user:secret@github.com/org/repo' },
    { git_url: 'https://127.0.0.1/org/repo' }, { git_url: 'https://evil.example/org/repo' }, { branch: '--upload-pack=sh' },
    { branch: 'HEAD~1' }, { root_dir: '../escape' }, { dockerfile_path: '/Dockerfile' }, { dockerfile_path: null }, { build_target: 'x;sh' }]) {
    assert.equal((await f.request('POST', base, { ...git, ...bad })).status, 400, JSON.stringify(bad));
  }
  for (const bad of [{ runtime_options: { bad: true } }, { desired_state: 'invalid' }, { desired_state: null },
    { cpu_nano_cpus: 'NaN' }, { memory_bytes: null }, { failure_retention_hours: -1 }, { source_type: 'image' }]) {
    assert.equal((await f.request('PATCH', `${base}/1`, { env: { MUST_NOT_WRITE: 'x' }, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls, []);
});

test('creation and config+env PATCH roll back together on env storage errors', async t => {
  const f = await fixture(t);
  t.mock.method(console, 'error', () => {});
  const before = structuredClone(f.services);
  f.state.failEnv = true;
  assert.equal((await f.request('POST', base, { ...image, env: { KEY: 'x' } })).status, 503);
  assert.deepEqual(f.services, before);
  assert.equal((await f.request('PATCH', `${base}/1`, { name: 'changed', env: { KEY: 'x' }, desired_state: 'stopped' })).status, 503);
  assert.deepEqual(f.services, before);
  assert.deepEqual(f.calls, []);
});

test('source edits and admin-only model mounts/GPU options validate before persistence', async t => {
  const f = await fixture(t);
  const { body: s } = await f.request('POST', base, git);
  const updated = await f.request('PATCH', `${base}/${s.id}`, {
    git_url: 'https://gitlab.com/org/model.git', ref: 'refs/tags/v1', root_dir: 'server', dockerfile_path: 'cpu.Dockerfile',
    build_target: null, exposure: 'http', deployment_strategy: 'recreate', runtime_options: { health_type: 'tcp' }, env: { KEY: 'value' },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.branch, 'refs/tags/v1');
  assert.equal(updated.body.root_dir, 'server');
  assert.equal(updated.body.runtime_options.health_type, 'tcp');
  assert.deepEqual(f.calls, []);
  const runtime_options = { host_config: { binds: ['/models/llama:/models:ro'], gpus: 'all' } };
  assert.equal((await f.request('PATCH', `${base}/${s.id}`, { runtime_options })).status, 400);
  f.user.admin = true;
  assert.equal((await f.request('PATCH', `${base}/${s.id}`, { runtime_options })).status, 200);
  assert.equal((await f.request('PATCH', `${base}/${s.id}`, { runtime_options: { host_config: { binds: ['/etc:/model:ro'] } } })).status, 400);
  const writes = f.writes.length;
  for (const body of [{ ...image, volume_path: '/data', runtime_options: { host_config: { binds: ['/models:/data:ro'] } } },
    { ...image, runtime_options: { host_config: { network_mode: 'none' } } }]) {
    assert.equal((await f.request('POST', base, { ...body, env: { MUST_NOT_WRITE: 'x' } })).status, 400);
  }
  assert.equal(f.writes.length, writes);
  const { body: pulled } = await f.request('POST', base, image);
  assert.equal((await f.request('PATCH', `${base}/${pulled.id}`, { image_ref: `ghcr.io/org/app@sha256:${'a'.repeat(64)}` })).status, 200);
  assert.equal((await f.request('POST', `${base}/${pulled.id}/deploy`, { ref: 'main' })).status, 400);
  assert.equal((await f.request('POST', `${base}/${pulled.id}/deploy`)).status, 202);
});

test('public space lists/activity/overview do not expose private repo or standalone services', async t => {
  const f = await fixture(t);
  const created = await f.request('POST', base, image);
  f.user.uid = 'outsider';
  assert.deepEqual((await f.request('GET')).body.map(s => s.id), [2]);
  const board = await f.request('GET', '/spaces/dev/deployments');
  assert.deepEqual(board.body.services.map(s => s.id), [2]);
  assert.deepEqual(board.body.activity.map(d => d.id), [20]);
  assert.equal(board.body.can_write, false);
  assert.deepEqual(board.body.capabilities, { host_mounts: false, bind_allowlist: [], gpus: false, git_hosts: ['github.com', 'gitlab.com'] });
  assert.deepEqual((await f.request('GET', '/deployments/overview')).body.map(s => s.id), [2]);
  for (const id of [1, created.body.id]) for (const suffix of ['', '/env', '/events', '/stats', '/uptime', '/http-logs', '/deployments', '/runtime-logs', '/domains']) {
    assert.equal((await f.request('GET', `${base}/${id}${suffix}`)).status, 404, `${id}${suffix}`);
  }
  assert.equal((await f.request('GET', '/repos/dev/private/+/deployments/services')).status, 404);
  assert.equal((await f.request('GET', '/repos/dev/private/+/deployments/dockerfiles')).status, 404);
  assert.equal((await f.request('GET', `${base}/2/runtime-logs`)).status, 403);
  assert.equal((await f.request('POST', `${base}/2/deploy`)).status, 403);
  f.user.admin = true;
  const adminBoard = await f.request('GET', '/spaces/dev/deployments');
  assert.equal(adminBoard.body.services.length, 3);
  assert.deepEqual(adminBoard.body.capabilities.bind_allowlist, ['/models']);
  assert.equal(adminBoard.body.capabilities.host_mounts, true);
  assert.equal(adminBoard.body.capabilities.gpus, true);
  f.user.blocked = true;
  for (const [method, path] of [['GET', base], ['GET', '/deployments/overview'], ['GET', '/spaces/dev/deployments'], ['POST', base], ['DELETE', `${base}/1`]]) {
    assert.equal((await f.request(method, path)).status, 403);
  }
});

test('scoping rejects cross-space, wrong repo aliases and child IDs before calling engine', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/spaces/other/deployments/services/1')).status, 404);
  assert.equal((await f.request('GET', '/repos/dev/public/+/deployments/services/1')).status, 404);
  assert.equal((await f.request('GET', '/repos/dev/private/+/deployments/services/1')).body.id, 1);
  assert.equal((await f.request('GET', `${base}/1`)).body.space_uid, 'dev', 'legacy null owner coalesces from repo');
  for (const child of ['20', 'nope', '-1', '9007199254740993']) {
    for (const action of ['cancel', 'redeploy', 'rollback']) assert.equal((await f.request('POST', `${base}/1/deployments/${child}/${action}`)).status, 404);
    assert.equal((await f.request('DELETE', `${base}/1/deployments/${child}`)).status, 404);
  }
  assert.equal((await f.request('POST', `${base}/2/domains/10/verify`)).status, 404);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.request('POST', `${base}/1/deployments/10/cancel`)).status, 200);
  assert.equal((await f.request('POST', '/repos/dev/private/+/deployments/services/1/deployments/10/redeploy')).status, 202);
  assert.equal((await f.request('GET', `${base}/1/runtime-logs?tail=50`)).body.logs, 'runtime output');
  assert.deepEqual(f.calls.at(-1), ['logs', 1, { tail: 50 }]);
  assert.equal((await f.request('POST', `${base}/1/deploy`, { ref: 'main', runtime_options: {} })).status, 400);
  for (const suffix of ['/runtime-logs?tail=NaN', '/deployments?limit=-1', '/http-logs?limit=1e9']) assert.equal((await f.request('GET', `${base}/1${suffix}`)).status, 400);
});

test('latest cancellation supports both UI paths without weakening writer or child ownership checks', async t => {
  const f = await fixture(t);
  const { body: standalone } = await f.request('POST', base, image);
  const paths = [`${base}/1`, '/repos/dev/private/+/deployments/services/1', `${base}/${standalone.id}`];
  for (const path of paths) {
    assert.equal((await f.request('POST', `${path}/deployments/latest/cancel`)).status, 200);
    assert.deepEqual(f.calls.at(-1), ['cancel', path.endsWith('/1') ? 1 : standalone.id]);
    for (const action of ['redeploy', 'rollback']) assert.equal((await f.request('POST', `${path}/deployments/latest/${action}`)).status, 404);
    for (const method of ['GET', 'DELETE']) assert.equal((await f.request(method, `${path}/deployments/latest`)).status, 404);
    assert.equal((await f.request('POST', `${path}/deployments/20/cancel`)).status, 404);
    assert.equal((await f.request('POST', `${path}/deployments/newest/cancel`)).status, 404);
  }
  assert.equal(f.calls.length, paths.length);
  assert.equal((await f.request('POST', '/spaces/other/deployments/services/1/deployments/latest/cancel')).status, 404);
  assert.equal((await f.request('POST', '/repos/dev/public/+/deployments/services/1/deployments/latest/cancel')).status, 404);
  f.user.uid = 'outsider';
  for (const path of paths) assert.equal((await f.request('POST', `${path}/deployments/latest/cancel`)).status, 404);
  for (const path of [`${base}/2`, '/repos/dev/public/+/deployments/services/2']) {
    assert.equal((await f.request('POST', `${path}/deployments/latest/cancel`)).status, 403);
  }
  f.user.admin = true;
  f.user.blocked = true;
  for (const path of paths) assert.equal((await f.request('POST', `${path}/deployments/latest/cancel`)).status, 403);
  assert.equal(f.calls.length, paths.length, 'unauthorized or incorrectly scoped requests never cancel a run');
});

test('internal domains are hidden and cannot be added, verified or provisioned', async t => {
  const f = await fixture(t);
  const { body: s } = await f.request('POST', base, image);
  f.domains.push({ id: 30, service_id: s.id, domain: 'old.example.com', verified: true });
  assert.deepEqual((await f.request('GET', `${base}/${s.id}/domains`)).body, []);
  assert.equal((await f.request('POST', `${base}/${s.id}/domains`, { domain: 'db.example.com' })).status, 400);
  for (const suffix of ['30/verify', '30/dns']) assert.equal((await f.request('POST', `${base}/${s.id}/domains/${suffix}`)).status, 400);
  assert.deepEqual((await f.request('GET', '/spaces/dev/deployments')).body.services.find(row => row.id === s.id).domains, []);
});

test('stop/delete await engine quiescence, propagate errors, and never request volume removal', async t => {
  const f = await fixture(t);
  const { body: s } = await f.request('POST', base, { ...image, volume_path: '/data' });
  assert.equal((await f.request('PATCH', `${base}/${s.id}`, { volume_path: null })).status, 400);
  assert.equal((await f.request('PATCH', `${base}/${s.id}`, { volume_path: '/elsewhere' })).status, 400);
  assert.equal((await f.request('PATCH', `${base}/${s.id}`, { deployment_strategy: 'blue_green' })).status, 400);
  f.state.stopError = Object.assign(new Error('still stopping'), { status: 409 });
  assert.equal((await f.request('DELETE', `${base}/${s.id}`)).status, 409);
  assert.equal((await f.request('PATCH', `${base}/${s.id}`, { desired_state: 'stopped' })).status, 409);
  assert.ok(f.services.some(row => row.id === s.id));
  f.state.stopError = null;
  let release;
  f.state.stopGate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { f.state.stopEntered = resolve; });
  const deletion = f.request('DELETE', `${base}/${s.id}`);
  await entered;
  assert.ok(f.services.some(row => row.id === s.id), 'metadata survives until all writers stop');
  assert.equal((await f.request('POST', `${base}/${s.id}/deploy`)).status, 409, 'no deploy can enter between stop and metadata deletion');
  release();
  assert.equal((await deletion).status, 200);
  assert.ok(!f.services.some(row => row.id === s.id));
  assert.ok(f.calls.every(call => call[0] === 'stop'));
  assert.ok(!f.queries.some(q => /DELETE.*volume/i.test(q.sql)));
});

test('standalone migration preserves populated legacy IDs/config/secrets/domains and uniqueness', {
  skip: !process.env.NIXRE_TEST_DATABASE_URL && 'Requires an explicitly configured disposable PostgreSQL test database',
}, async t => {
  const client = new pg.Client({ connectionString: process.env.NIXRE_TEST_DATABASE_URL });
  await client.connect();
  t.after(() => client.end());
  await client.query(`CREATE TEMP TABLE spaces (uid TEXT PRIMARY KEY);
    CREATE TEMP TABLE users (uid TEXT PRIMARY KEY);
    CREATE TEMP TABLE repos (id BIGINT PRIMARY KEY, space_uid TEXT REFERENCES spaces(uid));
    INSERT INTO spaces VALUES ('dev'); INSERT INTO users VALUES ('dev'); INSERT INTO repos VALUES (7, 'dev');`);
  // Run the shipped DDL against session-local tables only.
  const original = readFileSync(new URL('../db/migrations/021_deployments.sql', import.meta.url), 'utf8').replaceAll('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE');
  await client.query(original);
  await client.query(`INSERT INTO deploy_services (id, repo_id, name, root_dir, created_by, created, updated) VALUES (42, 7, 'kept', 'app', 'dev', 1, 2);
    INSERT INTO deployments (id, service_id, sha, started) VALUES (99, 42, 'deadbeef', 1);
    UPDATE deploy_services SET current_deployment_id = 99 WHERE id = 42;
    INSERT INTO service_env_vars VALUES (42, 'SECRET', 'opaque-encrypted-blob', 1);
    INSERT INTO deploy_domains (service_id, domain, created) VALUES (42, 'app.example.com', 1);`);
  const before = (await client.query('SELECT * FROM deploy_services WHERE id = 42')).rows[0];
  await client.query(readFileSync(new URL('../db/migrations/028_standalone_deployments.sql', import.meta.url), 'utf8'));
  const after = (await client.query('SELECT * FROM deploy_services WHERE id = 42')).rows[0];
  for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value, key);
  assert.equal(after.space_uid, 'dev');
  assert.equal(after.source_type, 'repo');
  assert.equal(after.exposure, 'http');
  assert.equal(after.deployment_strategy, 'blue_green');
  assert.equal((await client.query('SELECT value_enc FROM service_env_vars')).rows[0].value_enc, 'opaque-encrypted-blob');
  assert.equal((await client.query('SELECT domain FROM deploy_domains')).rows[0].domain, 'app.example.com');
  assert.equal((await client.query('SELECT config_snapshot FROM deployments')).rows[0].config_snapshot, null);
  const insert = `INSERT INTO deploy_services (repo_id, space_uid, source_type, name, auto_deploy, created_by, created, updated) VALUES ($1, $2, $3, $4, $5, 'dev', 1, 1)`;
  await client.query(insert, [7, null, 'repo', 'legacy-insert', true]);
  await assert.rejects(client.query(insert, [7, 'dev', 'repo', 'kept', true]), { code: '23505' });
  const imageService = (await client.query(`${insert} RETURNING id`, [null, 'dev', 'image', 'kept', false])).rows[0];
  const imageDeployment = (await client.query('INSERT INTO deployments (service_id, started) VALUES ($1, 1) RETURNING id, sha', [imageService.id])).rows[0];
  assert.equal(imageDeployment.sha, '', 'image deployments without a Git revision keep the shipped empty-string default');
  await client.query('UPDATE deployments SET sha = $1 WHERE id = $2', ['', imageDeployment.id]);
  await assert.rejects(client.query('UPDATE deployments SET sha = NULL WHERE id = $1', [imageDeployment.id]), { code: '23502' });
  await assert.rejects(client.query(insert, [null, 'dev', 'git', 'kept', false]), { code: '23505' });
  await assert.rejects(client.query(insert, [null, null, 'image', 'missing-space', false]), { code: '23514' });
  await assert.rejects(client.query(insert, [null, 'dev', 'image', 'auto', true]), { code: '23514' });
});
