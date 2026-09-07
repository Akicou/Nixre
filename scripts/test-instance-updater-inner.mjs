// Runs ONLY inside the disposable Docker daemon created by the upgrade test.
// The host worker talks to that daemon's socket, never the runner's socket.
import assert from 'node:assert/strict';
import { mkdir, cp, writeFile, readFile, chmod, symlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { HostDriver } from '/check/updater/driver.mjs';
import { createUpdater } from '/check/updater/server.mjs';

assert.match(process.env.CHECK_PREFIX || '', /^nixre-pr1-check-[a-f0-9]{12}$/);
const root = '/check/update-fixture';
const stateDir = root + '/data/updater';
await mkdir(stateDir, { recursive: true });
const runner = new HostDriver({ root, stateDir, logFile: stateDir + '/integration.log', publicUrl: 'http://127.0.0.1:3300' });
const docker = (...args) => runner.run('docker', args);
const git = (...args) => runner.git(...args);
assert.equal((await docker('info', '--format', '{{.Name}}')).output, `${process.env.CHECK_PREFIX}-dind`);
for (const directory of ['backend', 'ui']) await cp('/check/' + directory, root + '/' + directory, { recursive: true });
await writeFile(root + '/.gitignore', 'data\n.env\nnode_modules\n*.tsbuildinfo\n');
await writeFile(root + '/.env', '');
const project = 'nixre-updater-fixture';
const dbPassword = randomBytes(24).toString('hex');
const environment = { PGHOST: 'nixre-db', PGUSER: 'fixture', PGPASSWORD: dbPassword, PGDATABASE: 'fixture',
  AI_SECRET: randomBytes(32).toString('hex'), INTERNAL_TOKEN: randomBytes(32).toString('hex'),
  NIXRE_DATA_NETWORK: project + '_data', NIXRE_APPS_NETWORK: project + '_default',
  SANDBOX_NETWORK: project + '_default', SANDBOX_IMAGE: 'nixre-updater-fixture-sandbox:active',
  NIXRE_REGISTRATION_CLOSED: 'true', REPOS_ROOT: '/data/repos', DEPLOY_PROXY_PORT: '0' };
const config = { name: project, services: {
  'nixre-db': { image: 'postgres:16-alpine', environment: { POSTGRES_USER: 'fixture', POSTGRES_DB: 'fixture', POSTGRES_PASSWORD: dbPassword },
    networks: ['data'], volumes: ['./data/pg:/var/lib/postgresql/data'], healthcheck: { test: ['CMD', 'pg_isready', '-U', 'fixture'], interval: '1s', retries: 30 } },
  'nixre-core': { image: 'nixre-upgrade-core:test', environment, networks: ['default', 'data'], group_add: ['1000'],
    volumes: ['./data/repos:/data/repos', './data/update-control:/data/update-control:ro'],
    depends_on: { 'nixre-db': { condition: 'service_healthy' } } },
  'nixre-ssh': { image: 'nixre-upgrade-core:test', entrypoint: ['node'], command: ['-e', 'setInterval(()=>{},1000)'], networks: ['default'] },
  'nixre-web': { image: 'caddy:2-alpine', ports: ['127.0.0.1:3300:3000'], networks: ['default'],
    volumes: ['/check/Caddyfile:/etc/caddy/Caddyfile:ro', './ui/dist:/usr/share/caddy:ro', './data/update-web:/nixre-update-web:ro', './data/update-status:/nixre-update-status:ro'] },
}, networks: { default: {}, data: { internal: true } } };
await writeFile(root + '/docker-compose.yml', JSON.stringify(config));
await git('init', '-b', 'main');
await git('config', 'user.name', 'Updater Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
await git('add', '.'); await git('commit', '-m', 'Installed baseline');
const baseline = await git('rev-parse', 'HEAD');
const origin = root + '/data/origin.git';
const writer = root + '/data/writer';
await git('clone', '--bare', root, origin);
await git('remote', 'add', 'origin', 'https://github.com/Akicou/Nixre.git');
await git('worktree', 'add', '-b', 'fixture-writer', writer, 'main');
await mkdir(root + '/data/update-web/releases/' + baseline, { recursive: true });
await cp(root + '/ui/dist', root + '/data/update-web/releases/' + baseline, { recursive: true });
const index = root + '/data/update-web/releases/' + baseline + '/index.html';
await writeFile(index, (await readFile(index, 'utf8')) + `\n<!-- nixre-updater:${baseline} -->`);
await symlink('releases/' + baseline, root + '/data/update-web/current');
await mkdir(root + '/data/update-control', { recursive: true });
await mkdir(root + '/data/update-status', { recursive: true });
await docker('tag', 'nixre-upgrade-sandbox:test', environment.SANDBOX_IMAGE);
let failHealth = false;
class FixtureDriver extends HostDriver {
  async git(...args) {
    // Redirect only the network fetch to an isolated bare fixture repository.
    // All ancestry, dirty-worktree, diff, pinning, and publication checks run.
    if (args[0] === 'fetch') return (await this.run('git', ['fetch', '--no-tags', origin, 'main'])).output;
    return super.git(...args);
  }
  async checkCI() { return 'https://github.com/fixture/ci'; } // exact-SHA CI policy is separately unit-tested.
  async health(context, expected) {
    await super.health(context, expected);
    if (failHealth) throw new Error('Injected post-migration health failure.');
  }
}
const key = randomBytes(32).toString('hex');
const servers = await createUpdater({ root, stateDir, key,
  driverFactory: job => new FixtureDriver({ root, stateDir, publicUrl: 'http://127.0.0.1:3300', logFile: stateDir + '/' + job.id + '.log' }) });
await new Promise(resolve => servers.control.listen(root + '/data/update-control/control.sock', resolve));
await new Promise(resolve => servers.status.listen(root + '/data/update-status/status.sock', resolve));
await chmod(root + '/data/update-status/status.sock', 0o666);
function control(endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: root + '/data/update-control/control.sock', path: endpoint,
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(text)); else resolve(JSON.parse(text));
      });
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function settled() {
  for (let i = 0; i < 1200; i++) {
    const state = await control('/state');
    if (!['checking', 'running'].includes(state.current.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Updater did not settle.');
}
async function candidate(filename, sql) {
  await writeFile(writer + '/backend/src/db/migrations/' + filename, sql);
  await runner.run('git', ['add', '.'], { cwd: writer });
  await runner.run('git', ['commit', '-m', filename], { cwd: writer });
  await runner.run('git', ['push', origin, 'HEAD:main'], { cwd: writer });
  await control('/check', { requestId: randomUUID(), actor: 'fixture' });
  const state = await settled();
  assert.equal(state.current.status, 'checked', state.current.message);
  const plan = state.current.plan;
  return control('/apply', { requestId: randomUUID(), actor: 'fixture', planId: plan.id, target: plan.target, expectedBase: plan.base });
}
const compose = (...args) => runner.run('docker', ['compose', '-f', root + '/docker-compose.yml', ...args], { timeout: 120_000 });
try {
  await compose('up', '-d');
  // Wait for core's real database startup before preflight.
  const id = (await compose('ps', '-q', 'nixre-core')).output;
  for (let i = 0; i < 60; i++) {
    if ((await runner.run('docker', ['exec', id, 'node', '-e', "fetch('http://localhost:3002/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { allowFailure: true })).code === 0) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await candidate('998_update_fixture.sql', 'CREATE TABLE update_fixture (id integer PRIMARY KEY);');
  const success = await settled();
  assert.equal(success.current.status, 'succeeded', JSON.stringify(success.current));
  assert.equal(success.current.database, 'committed');
  assert.ok(success.current.backup.endsWith('/final.dump'));
  assert.equal(await git('rev-parse', 'HEAD'), success.current.plan.target);
  console.log('PASS real updater staged builds, restore rehearsal, final backup, migrations, revision health and atomic UI publication');

  await candidate('999_bad_fixture.sql', 'CREATE TABLE should_roll_back (id integer); SELECT missing_update_fixture_function();');
  const rejected = await settled();
  assert.equal(rejected.current.status, 'failed', JSON.stringify(rejected.current));
  assert.match(rejected.current.message, /999_bad_fixture.sql/);
  assert.ok(!rejected.current.quiesced);
  assert.equal(await git('rev-parse', 'HEAD'), success.current.plan.target);
  const dbId = (await compose('ps', '-q', 'nixre-db')).output;
  assert.equal((await docker('exec', dbId, 'psql', '-U', 'fixture', '-d', 'fixture', '-Atc', "SELECT count(*) FROM schema_migrations WHERE version='999_bad_fixture.sql'")).output, '0');
  console.log('PASS failed migration rehearsal leaves production serving and its schema / checkout unchanged');

  // Fix forward in the isolated writer; the production checkout never received
  // the rejected SQL file, so it is still an append-only migration there.
  failHealth = true;
  const started = await candidate('999_bad_fixture.sql', 'CREATE TABLE repaired_update_fixture (id integer);');
  const failed = await settled();
  assert.equal(failed.current.status, 'recovery_required', JSON.stringify(failed.current));
  assert.equal(failed.current.database, 'committed');
  assert.equal((await compose('ps', '-q', '--status', 'running', 'nixre-core')).output, '');
  const observed = await fetch('http://127.0.0.1:3300/update-status/current', { headers: { Authorization: `Bearer ${started.watchToken}` } });
  assert.equal(observed.status, 200);
  assert.equal((await observed.json()).status, 'recovery_required');
  assert.ok((await (await fetch('http://127.0.0.1:3300/update-progress')).text()).includes('nixre-updater:' + success.current.plan.target));
  console.log('PASS post-commit failure stops core, blocks old-image rollback, and keeps independent authenticated progress / old UI available');
} finally {
  servers.control.closeAllConnections(); servers.control.close();
  servers.status.closeAllConnections(); servers.status.close();
  await compose('down', '--volumes', '--remove-orphans');
}
