import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const state = { docker: null, queries: [], allowed: true, blocked: false, network: 'nixre-app', secret: null };
globalThis.__agentSandboxSecurity = state;
const sandboxURL = new URL('./agentSandbox.js', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const mocks = {
      '../db/pool.js': 'pool', './userSecrets.js': 'secrets',
      './dockerNetwork.js': 'network', dockerode: 'docker',
    };
    if (mocks[specifier] && (context.parentURL === sandboxURL || context.parentURL?.endsWith('/workspaces.js'))) {
      return { url: `test:sandbox-${mocks[specifier]}`, shortCircuit: true };
    }
    if (context.parentURL === sandboxURL && specifier === 'node:fs/promises') {
      return { url: 'test:sandbox-fs', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const sources = {
      'test:sandbox-fs': `export { constants } from 'node:fs/promises'; export async function access() {}`,
      'test:sandbox-docker': `export default class Docker { constructor() { return globalThis.__agentSandboxSecurity.docker; } }`,
      'test:sandbox-network': `export async function spawnedContainerNetwork() { return globalThis.__agentSandboxSecurity.network; }`,
      'test:sandbox-secrets': `export async function getDecryptedSecret() { return globalThis.__agentSandboxSecurity.secret; }`,
      'test:sandbox-pool': `export const pool = { async query(sql, params) {
        const s = globalThis.__agentSandboxSecurity;
        s.queries.push({ sql, params });
        if (sql.includes('FROM users')) return { rows: [{ uid: 'alice', admin: false, blocked: s.blocked }] };
        if (sql.includes('FROM repos')) return { rows: [{ space_uid: 'team', uid: 'repo', is_public: false }] };
        if (sql.includes('FROM space_members')) return { rows: s.allowed ? [{}] : [] };
        return { rows: [] };
      } };`,
    };
    if (sources[url]) return { format: 'module', shortCircuit: true, source: sources[url] };
    return next(url, context);
  },
});
const { writeFileInSandbox, readFileInSandbox, touchSandbox, initSandbox, startSandboxSweeper } = await import('./agentSandbox.js');
const { REPOS_ROOT } = await import('../git/repo.js');
after(() => { hooks.deregister(); delete globalThis.__agentSandboxSecurity; });

const context = { userId: 'alice', conversationId: 'chat', repoPath: 'team/repo', user: { uid: 'alice', name: 'Alice' } };
const hash = crypto.createHash('sha256').update('alice:chat:team/repo').digest('hex').slice(0, 20);
const volume = `nixre-sb-vol-${hash}`;
const name = `nixre-sb-${hash}`;
const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });
let containers;
let created;
let removed;
let stopped;
let scripts;
let volumeData;
let volumeRemovals;

function container(info) {
  let deleted = false;
  const instance = {
    id: info.Id,
    async inspect() { if (deleted) throw notFound(); return structuredClone(info); },
    async start() {
      if (deleted) throw notFound();
      if (info.State.Running) throw Object.assign(new Error('already running'), { statusCode: 304 });
      info.State = { Status: 'running', Running: true };
    },
    async stop() {
      if (deleted) throw notFound();
      if (!info.State.Running) throw Object.assign(new Error('already stopped'), { statusCode: 304 });
      stopped.push(info.Id); info.State = { Status: 'exited', Running: false };
    },
    async remove(options) {
      if (deleted) throw notFound();
      assert.notEqual(options?.v, true, 'upgrade must not remove volumes');
      deleted = true;
      removed.push(info.Id);
      containers.delete(info.Id);
      containers.delete(name);
    },
    modem: { demuxStream(stream, stdout) { stream.on('data', d => stdout.write(d)); } },
    async exec(options) {
      if (deleted) throw notFound();
      if (options.Cmd[2]?.includes('git config --global')) {
        state.syncEntered?.();
        if (state.syncGate) await state.syncGate;
      }
      scripts.push(options.Cmd);
      return {
        async start() {
          const stream = new PassThrough();
          setImmediate(() => { if (!stream.writableEnded) stream.end(); });
          return stream;
        },
        async inspect() { return { ExitCode: 0 }; },
      };
    },
  };
  containers.set(info.Id, instance);
  containers.set(name, instance);
  return instance;
}

function seedOld() {
  return container({
    Id: 'old', Config: { Image: 'nixre-agent-sandbox:latest', Labels: {
      'nixre.sandbox': 'true', 'nixre.user': 'alice', 'nixre.conversation': 'chat', 'nixre.repo': 'team/repo',
    } },
    State: { Status: 'running', Running: true }, HostConfig: { Binds: [`${volume}:/workspace`, `${REPOS_ROOT}:${REPOS_ROOT}:ro`] },
    Mounts: [{ Type: 'volume', Name: volume, Destination: '/workspace', RW: true },
      { Type: 'bind', Source: REPOS_ROOT, Destination: REPOS_ROOT, RW: false }],
    NetworkSettings: { Networks: { 'nixre-data': {} } },
  });
}

const fakeDocker = {
  async ping() {},
  getContainer(id) {
    return containers.get(id) || { async inspect() { throw notFound(); } };
  },
  getVolume(v) {
    assert.equal(v, volume);
    return { async inspect() { return { Name: v }; }, async remove() { volumeRemovals++; } };
  },
  async createVolume() { throw new Error('existing workspace must be retained'); },
  async createContainer(config) {
    if (containers.has(config.name)) throw Object.assign(new Error('name conflict'), { statusCode: 409 });
    created.push(config);
    return container({
      Id: `new-${created.length}`, Config: { Image: config.Image, Labels: config.Labels },
      HostConfig: config.HostConfig, State: { Status: 'created', Running: false },
      Mounts: [{ Type: 'volume', Name: volume, Destination: '/workspace', RW: true },
        { Type: 'bind', Source: path.join(REPOS_ROOT, 'team', 'repo.git'), Destination: path.join(REPOS_ROOT, 'team', 'repo.git'), RW: false }],
      NetworkSettings: { Networks: config.NetworkingConfig.EndpointsConfig },
    });
  },
  async listContainers() { return []; },
};

beforeEach(() => {
  containers = new Map(); created = []; removed = []; stopped = []; scripts = [];
  volumeData = { tracked: 'uncommitted edits', untracked: 'new file', commits: 'local branch' };
  volumeRemovals = 0;
  Object.assign(state, { docker: fakeDocker, queries: [], allowed: true, blocked: false, network: 'nixre-app', secret: null, syncGate: null, syncEntered: null });
});

test('boot quarantines old running sandboxes without deleting containers or volumes', async () => {
  const old = seedOld();
  fakeDocker.listContainers = async () => [{ Id: 'old', Names: [`/${name}`], Labels: (await old.inspect()).Config.Labels, State: 'running' }];
  try {
    await initSandbox();
    await new Promise(setImmediate);
    assert.deepEqual(stopped, ['old']);
    assert.deepEqual(removed, []);
    assert.equal(volumeRemovals, 0);
  } finally {
    fakeDocker.listContainers = async () => [];
  }
});

test('replaces old broad-mount sandbox with hardened repo-only container, retaining workspace', async () => {
  seedOld();
  const work = structuredClone(volumeData);
  await writeFileInSandbox({ ...context, filePath: 'hello.txt', content: 'hello' });
  assert.deepEqual(removed, ['old']);
  assert.deepEqual(stopped, ['old']);
  assert.equal(volumeRemovals, 0);
  assert.deepEqual(volumeData, work);
  assert.deepEqual(created[0].HostConfig.Binds, [`${volume}:/workspace`, `${path.join(REPOS_ROOT, 'team', 'repo.git')}:${path.join(REPOS_ROOT, 'team', 'repo.git')}:ro`]);
  assert.deepEqual(created[0].HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(created[0].HostConfig.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(created[0].HostConfig.NetworkMode, 'nixre-app');
  assert.ok(scripts.every(cmd => !cmd.join(' ').includes('reset --hard')));
  assert.equal(scripts.filter(cmd => cmd[2]?.includes('git config --global')).length, 1, 'sync once, not twice');
});

test('concurrent touch and write replace legacy sandbox once and retain workspace', { timeout: 5000 }, async t => {
  const old = seedOld();
  const work = structuredClone(volumeData);
  const stopping = Promise.withResolvers();
  const release = Promise.withResolvers();
  const stop = old.stop;
  t.mock.method(old, 'stop', async () => { stopping.resolve(); await release.promise; return stop(); });
  const touching = touchSandbox(context);
  await stopping.promise;
  const writing = writeFileInSandbox({ ...context, filePath: 'hello.txt', content: 'hello' });
  const results = Promise.all([touching, writing]);
  await new Promise(setImmediate);
  release.resolve();
  const [, written] = await results;
  assert.match(written.output, /Wrote 5 bytes/);
  assert.deepEqual(stopped, ['old']);
  assert.deepEqual(removed, ['old']);
  assert.equal(created.length, 1);
  assert.equal(created[0].HostConfig.Binds[0], `${volume}:/workspace`);
  assert.equal(scripts.filter(cmd => cmd[2]?.includes('git config --global')).length, 1);
  assert.equal(volumeRemovals, 0);
  assert.deepEqual(volumeData, work);
});

test('queued write waits for startup git sync and revalidates the running container', { timeout: 5000 }, async () => {
  seedOld();
  const syncing = Promise.withResolvers();
  const release = Promise.withResolvers();
  state.syncEntered = syncing.resolve;
  state.syncGate = release.promise;
  const touching = touchSandbox(context);
  await syncing.promise;
  const writing = writeFileInSandbox({ ...context, filePath: 'hello.txt', content: 'hello' });
  const results = Promise.all([touching, writing]);
  try {
    await new Promise(setImmediate);
    assert.equal(scripts.length, 0, 'no file exec may run while initial sync is blocked');
  } finally {
    release.resolve();
    await results;
  }
  assert.equal(created.length, 1);
  assert.equal(state.queries.filter(q => q.sql.includes('FROM users')).length, 2, 'queued caller must recheck authorization');
});

test('queued callers do not inherit authorization from another lifecycle operation', { timeout: 5000 }, async () => {
  seedOld();
  const syncing = Promise.withResolvers();
  const release = Promise.withResolvers();
  state.syncEntered = syncing.resolve;
  state.syncGate = release.promise;
  const touching = touchSandbox(context);
  await syncing.promise;
  const writing = writeFileInSandbox({ ...context, filePath: 'hello.txt', content: 'hello' });
  const results = Promise.allSettled([touching, writing]);
  state.allowed = false;
  release.resolve();
  const [touched, written] = await results;
  assert.equal(touched.status, 'fulfilled');
  assert.equal(written.status, 'rejected');
  assert.match(written.reason.message, /not found/);
  assert.equal(scripts.length, 1, 'only initial sync, no unauthorized write');
  // A failed queued operation must release its guard for a later retry.
  state.allowed = true;
  await writeFileInSandbox({ ...context, filePath: 'hello.txt', content: 'hello' });
  assert.equal(created.length, 1);
});

test('sweep queued behind replacement ignores its stale container ID', { timeout: 5000 }, async t => {
  const old = seedOld();
  const labels = (await old.inspect()).Config.Labels;
  const stopping = Promise.withResolvers();
  const release = Promise.withResolvers();
  const stop = old.stop;
  t.mock.method(old, 'stop', async () => { stopping.resolve(); await release.promise; return stop(); });
  t.mock.method(fakeDocker, 'listContainers', async () => [{ Id: 'old', Names: [`/${name}`], Labels: labels }]);
  t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  const touching = touchSandbox(context);
  await stopping.promise;
  const sweeping = startSandboxSweeper();
  const results = Promise.all([touching, sweeping]);
  await new Promise(setImmediate);
  release.resolve();
  await results;
  assert.deepEqual(stopped, ['old']);
  assert.deepEqual(removed, ['old']);
  assert.equal(created.length, 1);
  assert.equal((await containers.get(name).inspect()).State.Status, 'running');
  assert.equal(volumeRemovals, 0);
});

test('touch and write wait for an active quarantine sweep before replacing', { timeout: 5000 }, async t => {
  const old = seedOld();
  const labels = (await old.inspect()).Config.Labels;
  const stopping = Promise.withResolvers();
  const release = Promise.withResolvers();
  const stop = old.stop;
  t.mock.method(old, 'stop', async () => { stopping.resolve(); await release.promise; return stop(); });
  t.mock.method(fakeDocker, 'listContainers', async () => [{ Id: 'old', Names: [`/${name}`], Labels: labels }]);
  t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  const sweeping = startSandboxSweeper();
  await stopping.promise;
  const results = Promise.all([
    sweeping, touchSandbox(context),
    writeFileInSandbox({ ...context, filePath: 'hello.txt', content: 'hello' }),
  ]);
  await new Promise(setImmediate);
  release.resolve();
  await results;
  assert.deepEqual(stopped, ['old']);
  assert.deepEqual(removed, ['old']);
  assert.equal(created.length, 1);
  assert.equal(volumeRemovals, 0);
  assert.equal((await containers.get(name).inspect()).State.Status, 'running');
});

test('checks running sandboxes on read and touch, and replaces policy drift', async () => {
  seedOld();
  await readFileInSandbox({ ...context, filePath: 'image.png' });
  assert.equal(created.length, 1);
  const mutations = [
    config => { config.HostConfig.CapDrop = []; },
    config => { config.HostConfig.SecurityOpt = []; },
    config => { config.HostConfig.Privileged = true; },
    config => { config.HostConfig.CapAdd = ['SYS_ADMIN']; },
    config => { config.NetworkingConfig.EndpointsConfig['nixre-data'] = {}; },
    config => { config.Labels['nixre.sandbox.policy'] = 'old'; },
    config => { config.HostConfig.Binds.push('/var/run/docker.sock:/var/run/docker.sock'); },
  ];
  for (const mutate of mutations) {
    const count = created.length;
    mutate(created.at(-1));
    await touchSandbox(context);
    assert.equal(created.length, count + 1);
  }
  assert.equal(volumeRemovals, 0);
});

test('fresh authorization rejects revoked access and blocked users, stops sandbox and revokes its PAT', async () => {
  for (const blocked of [false, true]) {
    seedOld();
    state.allowed = false;
    state.blocked = blocked;
    await assert.rejects(touchSandbox({ ...context, user: { uid: 'alice', admin: true, blocked: false } }), /not found|blocked/);
  }
  assert.equal(created.length, 0);
  assert.equal(scripts.length, 0);
  assert.deepEqual(stopped, ['old', 'old']);
  assert.ok(state.queries.some(q => q.sql.startsWith('DELETE FROM tokens') && q.params[0] === `agent-sbx-${hash}`));
});

test('empty network selection fails closed and stops existing sandbox', async () => {
  seedOld(); state.network = '';
  await assert.rejects(writeFileInSandbox({ ...context, filePath: 'file', content: '' }), /safe sandbox network/);
  assert.equal(created.length, 0);
  assert.equal(scripts.length, 0);
  assert.deepEqual(stopped, ['old']);
});

test('unexpected workspace volume is stopped and retained for recovery', async () => {
  const old = seedOld();
  const inspect = old.inspect;
  old.inspect = async () => { const info = await inspect(); info.Mounts[0].Name = 'unexpected'; return info; };
  await assert.rejects(touchSandbox(context), /manual recovery/);
  assert.deepEqual(stopped, ['old']);
  assert.deepEqual(removed, []);
  assert.equal(volumeRemovals, 0);
});

test('rejects a mismatched credential identity before provisioning or minting tokens', async () => {
  await assert.rejects(writeFileInSandbox({ ...context, user: { uid: 'someone-else' }, filePath: 'file', content: '' }), /matching user/);
  assert.equal(created.length, 0);
  assert.equal(state.queries.length, 0);
});

test('git identity, credentials and file paths quote shell metacharacters literally', async () => {
  seedOld();
  const literal = "O'Brien $(printf INJECTED) `printf INJECTED` $HOME; & \\\"";
  state.secret = literal;
  await writeFileInSandbox({ ...context, user: { uid: 'alice', name: literal, email: literal }, filePath: `${literal}.txt`, content: 'hello' });
  const setup = scripts.find(cmd => cmd[2]?.includes('config user.name'))[2];
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  assert.ok(existsSync(bash), 'bash is required for the literal shell-argument regression');
  const identity = setup.split('\n').filter(line => /config user\.(name|email)/.test(line)).join('\n');
  const output = execFileSync(bash, ['-c', `git() { printf '%s\\0' "$@"; }; WORK=/ignored; ${identity}`], { encoding: 'utf8' });
  assert.deepEqual(output.split('\0').filter(Boolean), ['-C', '/ignored', 'config', 'user.name', literal, '-C', '/ignored', 'config', 'user.email', literal]);
  const tokenLine = setup.split('\n').find(line => line.endsWith('> /workspace/.github-token'));
  assert.equal(execFileSync(bash, ['-c', tokenLine.replace(/ > \/workspace\/\.github-token$/, '')], { encoding: 'utf8' }), literal);
  const target = scripts.at(-1)[2].split('\n').find(line => line.startsWith('base64 -d > ')).slice('base64 -d > '.length);
  assert.equal(execFileSync(bash, ['-c', `printf '%s' ${target}`], { encoding: 'utf8' }), `/workspace/repo/${literal}.txt`.replace(/\\/g, '/'));
});
