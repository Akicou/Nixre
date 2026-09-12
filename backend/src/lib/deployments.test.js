// Deployment lifecycle orchestration — hermetic tests. The engine gets a fake
// DB pool (in-memory tables interpreting its exact SQL), a FakeDocker that
// mirrors the dockerode surface it touches, and scripted IO drivers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';

import { createDeploymentEngine } from './deployments.js';
import { subscribe } from './deployBus.js';
import {
  makeImageTag,
  containerName,
} from './deployPure.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const decodeEnc = v => String(v).replace(/^enc:/, '');

// ---------------------------------------------------------------------------
// FakePool — interprets only the statements the engine issues.
// Contract: UPDATE ... SET col1=$1, col2=$2 ... WHERE id=$<last>
// ---------------------------------------------------------------------------

class FakePool {
  constructor({ pgIds = false } = {}) {
    this.pgIds = pgIds;
    this.services = new Map();
    this.deployments = new Map();
    this.envVars = new Map();
    this.repos = new Map();
    this.httpLogs = [];
    this.uptime = [];
    this.queries = [];
    this.nextServiceId = 10;
    this.nextDeploymentId = 100;
  }

  addRepo(space, repo, id = 7) {
    this.repos.set(`${space}/${repo}`, { id, space_uid: space, uid: repo });
  }

  addService(fields) {
    const row = {
      id: fields.id ?? this.nextServiceId++,
      repo_id: 7,
      name: 'web',
      root_dir: '.',
      dockerfile_path: 'Dockerfile',
      branch: 'main',
      auto_deploy: true,
      container_port: 8080,
      cpu_nano_cpus: 1e9,
      memory_bytes: 512 * 1024 * 1024,
      security_policy_version: 2,
      desired_state: 'running',
      status: 'idle',
      current_deployment_id: null,
      last_failed_deployment_id: null,
      preserve_status_min: 400,
      success_retention_hours: 24,
      failure_retention_hours: 168,
      ...fields,
    };
    this.services.set(row.id, row);
    return row;
  }

  seedEnv(serviceId, kv) {
    this.envVars.set(serviceId, new Map(Object.entries(kv)));
  }

  seedDeployment(id, fields) {
    const row = {
      id,
      service_id: 0,
      ref: '',
      sha: '',
      message: '',
      trigger_kind: 'manual',
      status: 'live',
      error: null,
      build_log: '',
      image_tag: null,
      started: Date.now(),
      finished: null,
      duration_ms: null,
      ...fields,
    };
    this.deployments.set(id, row);
    row.service_id = fields.service_id;
    return row;
  }

  rowById(table, id) {
    return [...table.values()].find(row => String(row.id) === String(id));
  }

  async query(sql, params = []) {
    const result = await this.execute(sql, params);
    if (!result.rows) return result;
    return { ...result, rows: result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, this.pgIds && value != null && /^(id|service_id|repo_id|current_deployment_id|last_failed_deployment_id)$/.test(key)
        ? String(value) : value]))) };
  }

  async execute(sql, params = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    this.queries.push(q);

    if (q === 'SELECT * FROM deploy_services WHERE id = $1') {
      const row = this.rowById(this.services, params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (
      q.startsWith('SELECT s.* FROM deploy_services s JOIN repos r ON r.id = s.repo_id')
    ) {
      const out = [...this.services.values()].filter(svc => {
        const repo = this.rowById(this.repos, svc.repo_id);
        return repo && `${repo.space_uid}/${repo.uid}` === `${params[0]}/${params[1]}`;
      });
      return { rows: out };
    }
    if (q === 'SELECT * FROM repos WHERE space_uid = $1 AND uid = $2') {
      const repo = this.repos.get(`${params[0]}/${params[1]}`);
      return { rows: repo ? [repo] : [] };
    }
    if (/^INSERT INTO deployments /.test(q)) {
      const row = {
        id: this.nextDeploymentId++,
        service_id: params[0],
        ref: params[1],
        sha: '',
        trigger_kind: params[2],
        status: 'queued',
        error: null,
        build_log: '',
        image_tag: null,
        started: params[3],
        finished: null,
        duration_ms: null,
      };
      this.deployments.set(row.id, row);
      return { rows: [{ ...row }] };
    }
    if (/^UPDATE deployments SET .+ WHERE id = \$\d+$/.test(q)) {
      return this.applyUpdate(this.deployments, q, params);
    }
    if (/^UPDATE deploy_services SET .+ WHERE id = \$\d+$/.test(q)) {
      return this.applyUpdate(this.services, q, params);
    }
    if (q === 'SELECT * FROM deployments WHERE id = $1') {
      const d = this.rowById(this.deployments, params[0]);
      return { rows: d ? [{ ...d }] : [] };
    }
    if (q === 'SELECT * FROM deployments WHERE image_tag = $1 AND id <> $2') {
      return { rows: [...this.deployments.values()].filter(d => d.image_tag === params[0] && String(d.id) !== String(params[1])) };
    }
    if (q === 'DELETE FROM deployments WHERE id = $1') {
      return { rowCount: this.deployments.delete(this.rowById(this.deployments, params[0])?.id) ? 1 : 0 };
    }
    if (q === 'SELECT * FROM repos WHERE id = $1') {
      const repo = this.rowById(this.repos, params[0]);
      return { rows: repo ? [repo] : [] };
    }
    if (q === 'SELECT key, value_enc FROM service_env_vars WHERE service_id = $1 ORDER BY key') {
      const kvs = this.envVars.get(this.rowById(this.services, params[0])?.id) || new Map();
      const rows = [...kvs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value_enc]) => ({ key, value_enc }));
      return { rows };
    }
    if (q.startsWith('SELECT * FROM deployments WHERE status IN')) {
      const active = ['queued', 'building', 'releasing'];
      return { rows: [...this.deployments.values()].filter(d => active.includes(d.status)) };
    }
    if (q === 'SELECT * FROM deploy_services') {
      return { rows: [...this.services.values()].map(s => ({ ...s })) };
    }
    if (/^INSERT INTO deploy_uptime_checks /.test(q)) {
      this.uptime.push({
        service_id: params[0],
        ok: params[1],
        latency_ms: params[2],
        status_code: params[3],
        ts: params[4],
      });
      return { rowCount: 1 };
    }
    if (q.startsWith('DELETE FROM deploy_uptime_checks ')) {
      // shape: service_id=$1 AND ts<$2
      const before = this.uptime.length;
      this.uptime = this.uptime.filter(u => !(String(u.service_id) === String(params[0]) && u.ts < params[1]));
      return { rowCount: before - this.uptime.length };
    }
    if (q.startsWith('DELETE FROM deploy_http_logs ')) {
      const before = this.httpLogs.length;
      this.httpLogs = this.httpLogs.filter(l => !this.matchesHttpWhere(q, params, l));
      return { rowCount: before - this.httpLogs.length };
    }
    throw new Error(`FakePool: unhandled query: ${q}`);
  }

  matchesHttpWhere(q, p, row) {
    const successShape = /service_id = \$1 AND ts < \$2 AND status_code < \$3/.test(q);
    if (successShape) {
      return String(row.service_id) === String(p[0]) && row.ts < p[1] && (row.status_code ?? 999) < p[2];
    }
    const failShape =
      /service_id = \$1 AND ts < \$2 AND \(status_code >= \$3 OR status_code IS NULL\)/.test(q);
    if (failShape) {
      return (
        String(row.service_id) === String(p[0]) &&
        row.ts < p[1] &&
        ((row.status_code ?? null) === null || row.status_code >= p[2])
      );
    }
    throw new Error(`FakePool: unknown http-log DELETE '${q}'`);
  }

  applyUpdate(table, q, params) {
    const setPart = q.slice(q.indexOf('SET ') + 4, q.lastIndexOf('WHERE'));
    const cols = setPart.split(',').map(c => c.trim().split(/\s|=/)[0]);
    const idIdx = cols.length; // id placeholder comes right after all columns
    const row = this.rowById(table, params[idIdx]);
    if (!row) return { rowCount: 0 };
    const shaIndex = cols.indexOf('sha');
    if (table === this.deployments && shaIndex >= 0 && params[shaIndex] == null) {
      throw Object.assign(new Error('null value in column "sha" violates not-null constraint'), { code: '23502' });
    }
    cols.forEach((col, i) => {
      row[col] = params[i];
    });
    return { rowCount: 1 };
  }
}

// ---------------------------------------------------------------------------
// FakeDocker — just enough of dockerode.
// ---------------------------------------------------------------------------

class FakeDocker {
  constructor() {
    this.containers = new Map(); // name -> rec
    this.images = new Set(); // tags
    this.buildCalls = []; // requested tags
    this.buildOptions = [];
    this.buildScript = () => ({ ok: true, lines: ['Step 1/1 : DONE'] });
    this.createCalls = [];
    this.pullCalls = [];
    this.infoCalls = 0;
    this.daemonInfo = { Architecture: 'x86_64', OSType: 'linux' };
    this.volumes = new Map();
    this.volumeCreates = [];
    this.modem = new Docker({ socketPath: '/unused' }).modem;
  }

  seedContainer(name, { running = true, ip = '10.0.0.9', labels = {} } = {}) {
    const rec = {
      name,
      id: `cid-${name}`,
      running,
      ip,
      labels,
      starts: 0,
      stops: 0,
      removes: 0,
      networks: { nixre: { IPAddress: ip } },
      health: this.healthStatus || 'healthy',
    };
    this.containers.set(name, rec);
    return rec;
  }

  seedImage(tag) {
    this.images.add(tag);
  }

  async ping() {}

  async info() {
    this.infoCalls++;
    return this.daemonInfo;
  }

  async buildImage(stream, opts) {
    this.buildCalls.push(opts.t);
    this.buildOptions.push(opts);
    await new Promise(resolve => {
      stream.on('data', () => {});
      stream.on('end', resolve);
      stream.on('error', resolve);
    });
    const out = this.buildScript();
    const pt = new PassThrough();
    if (!out.ok) pt.end(JSON.stringify({ error: out.error }) + '\n');
    else {
      this.seedImage(opts.t);
      pt.end(out.lines.map(l => JSON.stringify({ stream: l }) + '\n').join(''));
    }
    return pt;
  }

  async createContainer(opts) {
    this.createCalls.push(opts);
    this.seedContainer(opts.name, { labels: opts.Labels, running: false });
    return this.getContainer(opts.name);
  }

  async pull(ref) {
    this.pullCalls.push(ref);
    this.seedImage(ref);
    const stream = new PassThrough();
    if (this.pullScript) this.pullScript(stream);
    else stream.end(JSON.stringify({ status: 'Downloaded' }) + '\n');
    return stream;
  }

  getVolume(name) {
    return { inspect: async () => {
      if (!this.volumes.has(name)) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
      return this.volumes.get(name);
    } };
  }

  async createVolume(opts) {
    this.volumeCreates.push(opts);
    if (!this.volumes.has(opts.Name)) this.volumes.set(opts.Name, opts);
  }

  getContainer(name) {
    const rec = this.containers.get(name);
    if (!rec) {
      const err = new Error('no such container');
      err.statusCode = 404;
      err.reason = 'no such container';
      throw err;
    }
    return {
      inspect: async () => ({
        Id: rec.id,
        Name: `/${name}`,
        State: { Status: rec.running ? 'running' : 'exited', Health: { Status: rec.health } },
        Config: { Tty: rec.tty || false },
        NetworkSettings: { Networks: rec.networks },
        Labels: rec.labels,
      }),
      start: async () => {
        await this.beforeStart?.(rec);
        rec.starts++;
        rec.running = true;
      },
      stop: async () => {
        await this.beforeStop?.(rec);
        if (rec.stopError) throw new Error(rec.stopError);
        rec.stops++;
        rec.running = false;
      },
      remove: async () => {
        rec.removes++;
        this.containers.delete(name);
      },
      logs: async opts => { this.logOptions = opts; return rec.logs || Buffer.alloc(0); },
      stats: async () => rec.stats || {},
    };
  }

  async listContainers() {
    return [...this.containers.values()].map(r => ({
      Id: r.id,
      Names: [`/${r.name}`],
      Labels: r.labels,
      State: r.running ? 'running' : 'exited',
    }));
  }

  getNetwork(network) {
    return {
      connect: async ({ Container, EndpointConfig }) => {
        if (this.connectError) throw new Error(this.connectError);
        const rec = [...this.containers.values()].find(r => r.id === Container);
        rec.networks[network] = { IPAddress: rec.ip, ...EndpointConfig };
      },
      disconnect: async ({ Container }) => {
        const rec = [...this.containers.values()].find(r => r.id === Container);
        delete rec.networks[network];
      },
    };
  }

  getImage(tag) {
    return {
      inspect: async () => {
        if (!this.images.has(tag)) {
          const err = new Error('no such image');
          err.statusCode = 404;
          throw err;
        }
        return { Id: `sha256:${tag}` };
      },
      tag: async ({ repo, tag: suffix }) => this.images.add(`${repo}:${suffix}`),
      remove: async () => {
        this.images.delete(tag);
      },
    };
  }

  async listImages() {
    return [...this.images].map(tag => ({ RepoTags: [tag] }));
  }
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

function makeDrivers(overrides = {}) {
  return {
    async getDocker() {
      return overrides.docker ?? new FakeDocker();
    },
    async resolveRef(_space, _repo, ref) {
      return {
        sha: overrides.sha ?? 'deadbeefcafe',
        message: overrides.message ?? 'commit msg',
        ref,
      };
    },
    async archiveTar(_space, _repo, _spec, _signal) {
      const pt = new PassThrough();
      pt.end(Buffer.from('tar-bytes'));
      return pt;
    },
    async listTree() {
      return ['Dockerfile', 'src/index.js'];
    },
    async probeHttp() {
      return overrides.probe ?? (async () => ({ ok: true, status: 200 }));
    },
    async networkName() {
      return 'nixre';
    },
    now: () => 1_700_000_000_000,
    ...overrides.drivers,
  };
}

function makeEngine(pool, overrides = {}) {
  const drivers = makeDrivers(overrides);
  const engine = createDeploymentEngine({
    pool,
    drivers,
    decryptValue: overrides.decryptValue ?? decodeEnc,
    healthTimeoutMs: overrides.healthTimeoutMs ?? 50,
    drainMs: overrides.drainMs ?? 2,
    buildTimeoutMs: overrides.buildTimeoutMs,
    keepImages: overrides.keepImages,
    clock: () => 1_700_000_000_000,
  });
  return { engine, drivers };
}

// Wait until the engine reports no active run for the service.
async function settle(engine, serviceId) {
  for (let i = 0; i < 500 && engine.isBusy(serviceId); i++) await sleep(2);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('create options inject decrypted env, limits, labels, restart policy', async () => {
  const pool = new FakePool();
  pool.addRepo('acme', 'mono');
  const svc = pool.addService({});
  pool.seedEnv(svc.id, { API_KEY: 'enc:s3cret', LOG_LEVEL: 'enc:debug' });

  const docker = new FakeDocker();
  const { engine } = await makeEngine(pool, { docker });

  await engine.startDeployment(svc.id, { trigger: 'manual' });
  await settle(engine, svc.id);

  assert.equal(pool.services.get(svc.id).current_deployment_id, 100);
  const create = docker.createCalls.at(-1);
  assert.equal(create.name, containerName(svc.id, 100));
  assert.deepEqual(
    create.Env.sort(),
    ['API_KEY=s3cret', 'LOG_LEVEL=debug'],
    'env vars must be decrypted at container-create time',
  );
  assert.equal(create.HostConfig.Memory, svc.memory_bytes);
  assert.equal(create.HostConfig.NanoCpus, Number(svc.cpu_nano_cpus));
  assert.equal(create.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.equal(create.Labels['nixre.service'], String(svc.id));
  assert.match(create.Labels['nixre.deployment'], /^\d+$/);
  assert.ok(create.NetworkingConfig.EndpointsConfig.nixre, 'joins core network');
  assert.deepEqual(create.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(create.HostConfig.SecurityOpt, ['no-new-privileges:true']);
});

test('503 health response does not replace the serving deployment', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({ current_deployment_id: 9 });
  const docker = new FakeDocker();
  const old = docker.seedContainer(containerName(svc.id, 9));
  const { engine } = makeEngine(pool, { docker, probe: async () => ({ ok: false, status: 503 }) });
  await engine.startDeployment(svc.id);
  await engine.waitAllIdle();
  assert.equal(pool.services.get(svc.id).current_deployment_id, 9);
  assert.equal(pool.deployments.get(100).status, 'failed');
  assert.equal(old.removes, 0);
  assert.equal(old.stops, 0);
});

test('legacy services retain default/add-only caps and escalation semantics on recreation', async () => {
  for (const runtime_options of [null, {}, { host_config: { cap_drop: [], cap_add: ['NET_ADMIN'] } }]) {
    const pool = new FakePool();
    pool.addRepo('a', 'b');
    const svc = pool.addService({ security_policy_version: 1, runtime_options });
    const docker = new FakeDocker();
    const { engine } = makeEngine(pool, { docker });
    await engine.startDeployment(svc.id, { _reuseImage: 'old-image:latest' });
    await engine.waitAllIdle();
    const config = docker.createCalls[0].HostConfig;
    assert.equal(config.CapDrop, undefined);
    assert.equal(config.SecurityOpt, undefined);
    assert.deepEqual(config.CapAdd, runtime_options?.host_config?.cap_add);
  }
});

test('new policy applies with null, empty and add-only options but respects explicit drops', async () => {
  for (const runtime_options of [null, {}, { host_config: { cap_add: ['NET_ADMIN'], cap_drop: [] } },
    { host_config: { cap_drop: ['NET_RAW'] } }]) {
    const pool = new FakePool();
    pool.addRepo('a', 'b');
    const svc = pool.addService({ security_policy_version: 2, runtime_options });
    const docker = new FakeDocker();
    const { engine } = makeEngine(pool, { docker });
    await engine.startDeployment(svc.id, { _reuseImage: 'image:latest' });
    await engine.waitAllIdle();
    const config = docker.createCalls[0].HostConfig;
    assert.deepEqual(config.CapDrop, runtime_options?.host_config?.cap_drop?.length ? ['NET_RAW'] : ['ALL']);
    assert.deepEqual(config.SecurityOpt, ['no-new-privileges:true']);
  }
});

test('redeploy after an explicit policy 1-to-2 update uses hardened caps without modifying the old container in place', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({ security_policy_version: 1 });
  const docker = new FakeDocker();
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id, { _reuseImage: 'image:latest' });
  await engine.waitAllIdle();
  assert.equal(docker.createCalls[0].HostConfig.CapDrop, undefined);
  const old = docker.containers.get(docker.createCalls[0].name);
  // This is the persisted field written by the admin-only PATCH route.
  await pool.query('UPDATE deploy_services SET security_policy_version = $1 WHERE id = $2', [2, svc.id]);
  assert.equal(old.removes, 0);
  assert.equal(old.stops, 0);
  await engine.redeploy(svc.id);
  await engine.waitAllIdle();
  assert.deepEqual(docker.createCalls.at(-1).HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(docker.createCalls.at(-1).HostConfig.SecurityOpt, ['no-new-privileges:true']);
});

test('legacy app network migration keeps the container and joins before disconnecting', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({ security_policy_version: 1, current_deployment_id: 9 });
  pool.seedDeployment(9, { service_id: svc.id, image_tag: 'old:latest' });
  const docker = new FakeDocker();
  const rec = docker.seedContainer(containerName(svc.id, 9));
  rec.networks = { old_default: { IPAddress: rec.ip }, 'old_nixre-data': { IPAddress: '10.2.0.1' } };
  const { engine } = makeEngine(pool, { docker });
  await engine.sweep();
  assert.deepEqual(Object.keys(rec.networks), ['nixre']);
  assert.equal(rec.removes, 0);
  assert.equal(rec.stops, 0);
  assert.equal(docker.createCalls.length, 0);
});

test('failed network migration does not delete the container or disconnect its old network', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({ current_deployment_id: 9 });
  pool.seedDeployment(9, { service_id: svc.id, image_tag: 'old:latest' });
  const docker = new FakeDocker();
  const rec = docker.seedContainer(containerName(svc.id, 9));
  rec.networks = { old_default: { IPAddress: rec.ip } };
  docker.connectError = 'network unavailable';
  const { engine } = makeEngine(pool, { docker });
  await engine.sweep();
  assert.deepEqual(Object.keys(rec.networks), ['old_default']);
  assert.equal(rec.removes, 0);
  assert.equal(pool.services.get(svc.id).status, 'failed');
});

test('invalid network selection fails closed rather than creating a default-bridge container', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});
  const docker = new FakeDocker();
  const { engine } = makeEngine(pool, { docker, drivers: { networkName: async () => { throw new Error('unsafe network'); } } });
  await engine.startDeployment(svc.id, { _reuseImage: 'image:latest' });
  await engine.waitAllIdle();
  assert.equal(docker.createCalls.length, 0);
  assert.equal(pool.deployments.get(100).status, 'failed');
});

test('a pre-existing candidate is not deleted by a conflicting create attempt', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});
  const docker = new FakeDocker();
  const existing = docker.seedContainer(containerName(svc.id, 100));
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id, { _reuseImage: 'old-image:latest' });
  await engine.waitAllIdle();
  assert.equal(existing.removes, 0);
  assert.equal(existing.stops, 0);
  assert.equal(docker.createCalls.length, 0);
  assert.equal(pool.deployments.get(100).status, 'failed');
});

test('explicit admin network modes bypass migration even when approved-network discovery would fail', async () => {
  for (const mode of ['host', 'bridge', 'none', 'container:custom-service']) {
    const pool = new FakePool();
    pool.addRepo('a', 'b');
    const svc = pool.addService({ current_deployment_id: 9, runtime_options: { host_config: { network_mode: mode } } });
    pool.seedDeployment(9, { service_id: svc.id, image_tag: 'old-image:latest' });
    const docker = new FakeDocker();
    const rec = docker.seedContainer(containerName(svc.id, 9));
    rec.networks = { custom: {} };
    const { engine } = makeEngine(pool, { docker, drivers: { networkName: async () => { throw new Error('must not discover'); } } });
    await engine.sweep();
    assert.deepEqual(rec.networks, { custom: {} });
    assert.equal(rec.removes, 0);
    assert.equal(pool.services.get(svc.id).status, 'running');
  }
});

test('legacy boot recreation retains policy while new privileged services omit no-new-privileges', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({ current_deployment_id: 9, security_policy_version: 1,
    runtime_options: JSON.stringify({ host_config: { cap_add: ['NET_ADMIN'], cap_drop: [] } }) });
  pool.seedDeployment(9, { service_id: svc.id, image_tag: 'old-image:latest' });
  const docker = new FakeDocker();
  const { engine } = makeEngine(pool, { docker });
  await engine.sweep();
  assert.equal(docker.createCalls[0].HostConfig.CapDrop, undefined);
  assert.equal(docker.createCalls[0].HostConfig.SecurityOpt, undefined);
  assert.deepEqual(docker.createCalls[0].HostConfig.CapAdd, ['NET_ADMIN']);
  const privileged = pool.addService({ runtime_options: { host_config: { privileged: true } } });
  await engine.startDeployment(privileged.id, { _reuseImage: 'image:latest' });
  await engine.waitAllIdle();
  assert.equal(docker.createCalls.at(-1).HostConfig.Privileged, true);
  assert.equal(docker.createCalls.at(-1).HostConfig.SecurityOpt, undefined);
});

test('runtime options merge into the docker create payload', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({
    runtime_options: {
      version: 1,
      health_path: '/health',
      health_timeout_ms: 5_000,
      entrypoint: ['/bin/sh', '-c'],
      host_config: {
        binds: ['/var/run/docker.sock:/var/run/docker.sock', '/var/lib/ws:/workspace:rw'],
        cap_add: ['NET_ADMIN'],
        group_add: [998],
        extra_hosts: ['db:10.0.0.5'],
        shm_size: 268_435_456,
        tmpfs: { '/run': '' },
      },
    },
  });

  const docker = new FakeDocker();
  const probed = [];
  const { engine } = await makeEngine(pool, {
    docker,
    drivers: {
      probeHttp: () => async arg => {
        probed.push(arg);
        return { ok: true, status: 200 };
      },
    },
  });

  await engine.startDeployment(svc.id, { trigger: 'manual' });
  await settle(engine, svc.id);

  assert.equal(pool.services.get(svc.id).status, 'running');
  const create = docker.createCalls.at(-1);
  assert.deepEqual(create.HostConfig.Binds, [
    '/var/run/docker.sock:/var/run/docker.sock',
    '/var/lib/ws:/workspace:rw',
  ]);
  assert.equal(create.HostConfig.Privileged, undefined, 'privileged stays unset when false');
  assert.deepEqual(create.HostConfig.CapAdd, ['NET_ADMIN']);
  assert.deepEqual(create.HostConfig.GroupAdd, [998]);
  assert.deepEqual(create.HostConfig.ExtraHosts, ['db:10.0.0.5']);
  assert.equal(create.HostConfig.ShmSize, 268_435_456);
  assert.deepEqual(create.HostConfig.Tmpfs, { '/run': '' });
  assert.equal(create.HostConfig.NetworkMode, undefined, 'no network_mode keeps core-network join');
  assert.ok(create.NetworkingConfig.EndpointsConfig.nixre, 'core network attached');
  assert.deepEqual(create.Entrypoint, ['/bin/sh', '-c']);
  assert.equal(create.Cmd, undefined);

  // The release probe hit the configured health path, not "/".
  assert.ok(probed.length > 0);
  assert.equal(probed[0].path, '/health');
});

test('network_mode=host skips the core-network attachment', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({
    runtime_options: {
      version: 1,
      health_path: '/',
      host_config: { network_mode: 'host' },
    },
  });

  const docker = new FakeDocker();
  const { engine } = await makeEngine(pool, { docker });
  await engine.startDeployment(svc.id, { trigger: 'manual' });
  await settle(engine, svc.id);

  const create = docker.createCalls.at(-1);
  assert.equal(create.HostConfig.NetworkMode, 'host');
  assert.equal(create.NetworkingConfig, undefined, 'host mode must not pass EndpointsConfig');
});

test('services without runtime options launch exactly as before', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});

  const docker = new FakeDocker();
  const probed = [];
  const { engine } = await makeEngine(pool, {
    docker,
    drivers: {
      probeHttp: () => async arg => {
        probed.push(arg);
        return { ok: true, status: 200 };
      },
    },
  });
  await engine.startDeployment(svc.id, { trigger: 'manual' });
  await settle(engine, svc.id);

  const create = docker.createCalls.at(-1);
  assert.equal(create.HostConfig.Binds, undefined);
  assert.equal(create.HostConfig.Privileged, undefined);
  assert.equal(create.HostConfig.NetworkMode, undefined);
  assert.ok(create.NetworkingConfig.EndpointsConfig.nixre);
  assert.equal(probed[0].path, '/');
});

test('blue/green swap replaces the old container only after health', async () => {
  const pool = new FakePool();
  pool.addRepo('acme', 'mono');
  const svc = pool.addService({});
  pool.seedDeployment(11, { service_id: svc.id, image_tag: makeImageTag(svc.id, 11) });
  svc.current_deployment_id = 11;

  const docker = new FakeDocker();
  docker.seedImage(makeImageTag(svc.id, 11));
  const oldRec = docker.seedContainer(containerName(svc.id, 11), {
    labels: { 'nixre.service': String(svc.id), 'nixre.deployment': '11' },
  });

  const { engine } = await makeEngine(pool, { docker });
  await engine.startDeployment(svc.id, { trigger: 'manual' });
  await settle(engine, svc.id);
  // Old-container retirement happens after a short drain delay.
  await sleep(30);

  assert.equal(oldRec.stops, 1, 'previous container stopped during swap');
  assert.ok(!docker.containers.has(containerName(svc.id, 11)), 'old container removed');

  const dep = pool.deployments.get(100);
  assert.equal(dep.status, 'live');
  assert.equal(dep.image_tag, makeImageTag(svc.id, 100));
  assert.ok(dep.build_log.includes('DONE'), 'build log persisted');
  assert.equal(dep.trigger_kind, 'manual');
  assert.equal(svc.status, 'running');
});

test('build failure marks failed and leaves previous release serving', async () => {
  const pool = new FakePool();
  pool.addRepo('acme', 'mono');
  const svc = pool.addService({});
  pool.seedDeployment(11, { service_id: svc.id, image_tag: makeImageTag(svc.id, 11) });
  svc.current_deployment_id = 11;

  const docker = new FakeDocker();
  docker.seedImage(makeImageTag(svc.id, 11));
  const oldRec = docker.seedContainer(containerName(svc.id, 11), {
    labels: { 'nixre.service': String(svc.id) },
  });
  docker.buildScript = () => ({ ok: false, error: 'npm install exploded' });

  const { engine } = await makeEngine(pool, { docker });
  await engine.startDeployment(svc.id, { trigger: 'push' });
  await settle(engine, svc.id);

  const dep = pool.deployments.get(100);
  assert.equal(dep.status, 'failed');
  assert.match(dep.error, /npm install exploded/);
  assert.equal(svc.current_deployment_id, 11, 'fallback intact');
  assert.equal(svc.status, 'running', 'still serving predecessor');
  assert.equal(svc.last_failed_deployment_id, 100, 'failure recorded for warnings');  assert.equal(oldRec.running, true, 'old container untouched');
});

test('first-deploy failure leaves the service failed', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});
  const docker = new FakeDocker();
  docker.buildScript = () => ({ ok: false, error: 'nope' });

  const { engine } = await makeEngine(pool, { docker });
  await engine.startDeployment(svc.id, { trigger: 'manual' });
  await settle(engine, svc.id);

  assert.equal(svc.current_deployment_id, null);
  assert.equal(svc.status, 'failed');
  assert.equal(svc.last_failed_deployment_id, 100);
});

test('unhealthy release fails and removes the candidate container', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});

  const docker = new FakeDocker();
  const { engine } = await makeEngine(pool, {
    docker,
    drivers: {
      probeHttp: () => async () => ({ ok: false }),
    },
  });

  await engine.startDeployment(svc.id, { trigger: 'manual' });
  await settle(engine, svc.id);

  const dep = pool.deployments.get(100);
  assert.equal(dep.status, 'failed');
  assert.match(dep.error, /health/i);
  assert.equal(svc.status, 'failed');
  assert.equal(docker.containers.size, 0, 'candidate cleaned up');
});

test('ref that fails to resolve fails the deployment', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({ branch: 'main' });

  const { engine } = await makeEngine(pool, {
    drivers: {
      resolveRef: () => Promise.reject(new Error('unknown revision')),
    },
  });
  await engine.startDeployment(svc.id, { trigger: 'manual' });
  await settle(engine, svc.id);

  const dep = pool.deployments.get(100);
  assert.equal(dep.status, 'failed');
  assert.match(dep.error, /unknown revision/);
});

test('concurrent deploys of one service are rejected with 409', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});

  let releaseProbe;
  const gate = new Promise(res => (releaseProbe = res));

  const { engine } = await makeEngine(pool, {
    drivers: {
      probeHttp: () => async () => {
        await gate; // hold mid-release
        return { ok: true, status: 200 };
      },
    },
  });

  const first = engine.startDeployment(svc.id, { trigger: 'manual' }).catch(e => e);
  await sleep(5); // reach the health-wait phase
  await assert.rejects(
    () => engine.startDeployment(svc.id, { trigger: 'manual' }),
    err => err.status === 409,
  );
  releaseProbe();
  await first;
  await settle(engine, svc.id);
});

test('cancel aborts mid-build and marks cancelled', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});

  const { engine } = await makeEngine(pool, {
    drivers: {
      archiveTar: (_s, _r, _spec, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('Build cancelled'), { cancelled: true })),
          );
          setTimeout(() => reject(new Error('never')), 5000);
        }),
    },
  });

  const { deploymentId } = await engine.startDeployment(svc.id, { trigger: 'manual' });
  await sleep(5);
  await engine.cancelDeployment(svc.id);
  await settle(engine, svc.id);
  assert.equal(pool.deployments.get(deploymentId).status, 'cancelled');
  assert.equal(svc.current_deployment_id, null);
});

test('rollback re-releases an older image without rebuilding', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});
  pool.seedDeployment(11, {
    service_id: svc.id,
    image_tag: makeImageTag(svc.id, 11),
    sha: 'aaa111',
    message: 'older good one',
  });
  pool.seedDeployment(12, {
    service_id: svc.id,
    image_tag: makeImageTag(svc.id, 12),
    sha: 'bbb222',
  });
  svc.current_deployment_id = 12;

  const docker = new FakeDocker();
  docker.seedImage(makeImageTag(svc.id, 11));

  const { engine } = await makeEngine(pool, { docker });
  const dep = await engine.rollback(svc.id, 11);
  await settle(engine, svc.id);

  assert.deepEqual(docker.buildCalls, [], 'rollback never rebuilds');
  assert.equal(dep.trigger_kind, 'rollback');
  assert.equal(dep.ref, 'aaa111');

  const cur = pool.services.get(svc.id).current_deployment_id;
  assert.notEqual(cur, 11, 'rollback lands as a NEW deployment row');
  assert.equal(pool.deployments.get(cur).image_tag, makeImageTag(svc.id, 11));
  assert.equal(pool.deployments.get(cur).sha, 'aaa111');

  // Rolling back to what already serves makes no sense.
  await assert.rejects(() => engine.rollback(svc.id, cur), err => err.status === 400);
});

test('deleteDeployment refuses the serving release, allows old ones', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});
  pool.seedDeployment(11, { service_id: svc.id, status: 'live' });
  pool.seedDeployment(12, { service_id: svc.id, status: 'failed' });
  svc.current_deployment_id = 11;

  const { engine } = await makeEngine(pool, {});
  await assert.rejects(() => engine.deleteDeployment(svc.id, 11), err => err.status === 400);
  await engine.deleteDeployment(svc.id, 12);
  assert.ok(!pool.deployments.has(12));
});

test('maybeAutoDeploy kicks matching auto_deploy services only', async () => {
  const pool = new FakePool();
  pool.addRepo('acme', 'mono');
  pool.addService({ name: 'api', branch: 'main' });
  pool.addService({ name: 'worker', branch: 'staging' });
  pool.addService({ name: 'cms', branch: 'main', auto_deploy: false });
  pool.addService({ name: 'frozen', branch: 'main', desired_state: 'stopped' });

  let releaseGate;
  const gate = new Promise(res => (releaseGate = res));
  const { engine } = await makeEngine(pool, {
    drivers: {
      probeHttp: () => async () => {
        await gate; // hold the run mid-release
        return { ok: true, status: 200 };
      },
    },
  });

  const kicked = await engine.maybeAutoDeploy({
    space: 'acme',
    repo: 'mono',
    branch: 'main',
    after: 'f00dfeed',
  });
  assert.equal(kicked, 1, 'only api matches (branch + auto_deploy + running)');

  // A second push while that run is still in flight dedupes to zero kicks.
  const second = await engine.maybeAutoDeploy({
    space: 'acme',
    repo: 'mono',
    branch: 'main',
    after: 'ffffff01',
  });
  assert.equal(second, 0);

  releaseGate();
  await engine.waitAllIdle();

  const pushes = [...pool.deployments.values()].filter(d => d.trigger_kind === 'push');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].ref, 'f00dfeed');
});

test('sweep recreates dead containers from stored images (boot autostart)', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});
  pool.seedDeployment(11, { service_id: svc.id, image_tag: makeImageTag(svc.id, 11) });
  svc.current_deployment_id = 11;

  const docker = new FakeDocker();
  docker.seedImage(makeImageTag(svc.id, 11)); // container gone entirely

  const { engine } = await makeEngine(pool, { docker });
  await engine.sweep();
  await settle(engine, svc.id);

  const rec = docker.containers.get(containerName(svc.id, 11));
  assert.ok(rec, 'container recreated');
  assert.equal(rec.running, true);
  assert.deepEqual(docker.buildCalls, []);
  assert.equal(pool.services.get(svc.id).status, 'running');
});

test('sweep stops containers of desired-stopped services', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({ desired_state: 'stopped', status: 'running' });
  pool.seedDeployment(11, { service_id: svc.id, image_tag: makeImageTag(svc.id, 11) });
  svc.current_deployment_id = 11;

  const docker = new FakeDocker();
  docker.seedImage(makeImageTag(svc.id, 11));
  const rec = docker.seedContainer(containerName(svc.id, 11), {
    labels: { 'nixre.service': String(svc.id), 'nixre.deployment': '11' },
  });

  const { engine } = await makeEngine(pool, { docker });
  await engine.sweep();

  assert.equal(rec.stops, 1);
  assert.equal(pool.services.get(svc.id).status, 'stopped');
});

test('sweep reconciles orphaned runs from a crashed process', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});
  pool.seedDeployment(50, { service_id: svc.id, status: 'building' });
  svc.status = 'deploying';

  const { engine } = await makeEngine(pool, {});
  await engine.sweep();

  const dep = pool.deployments.get(50);
  assert.equal(dep.status, 'failed');
  assert.match(dep.error, /interrupted/i);
});

test('http log retention preserves failures and prunes stale successes', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});
  const hourMs = 3600_000;
  const dayMs = 24 * hourMs;
  const now = 1_700_000_000_000;

  pool.httpLogs = [
    { service_id: svc.id, ts: now - 30 * hourMs, status_code: 200 }, // stale success -> gone
    { service_id: svc.id, ts: now - 30 * hourMs, status_code: 404 }, // fresh failure (168h window)
    { service_id: svc.id, ts: now - hourMs, status_code: 200 },      // fresh success stays
    { service_id: svc.id, ts: now - 8 * dayMs, status_code: 500 },   // ancient failure -> gone
    { service_id: svc.id, ts: now - 2 * hourMs, status_code: null }, // proxy error kept long
  ];

  const { engine } = await makeEngine(pool, {});
  await engine.sweep(now);

  const remaining = pool.httpLogs.map(l => String(l.status_code)).sort();
  assert.deepEqual(remaining, ['200', '404', 'null']);
});

function addStandalone(pool, fields = {}) {
  return pool.addService({ repo_id: null, space_uid: 'acme', source_type: 'image',
    image_ref: 'example/app:latest', exposure: 'internal', deployment_strategy: 'recreate',
    auto_deploy: false, ...fields });
}

const postgres = { template: 'postgres', image_ref: 'postgres:16', volume_path: '/var/lib/postgresql/data', container_port: 5432 };

test('image source has no forge lookup, pins a private release tag and restarts without pulling', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool);
  pool.seedEnv(svc.id, { TOKEN: 'enc:do-not-snapshot' });
  const docker = new FakeDocker();
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id);
  await engine.waitAllIdle();
  const dep = pool.deployments.get(100);
  assert.equal(dep.status, 'live');
  assert.equal(dep.sha, '');
  assert.equal(dep.ref, 'example/app:latest', 'image history identifies the image, not a fictitious Git branch');
  assert.equal(dep.image_tag, makeImageTag(svc.id, 100));
  assert.equal(docker.createCalls[0].Image, dep.image_tag);
  assert.deepEqual(docker.pullCalls, ['example/app:latest']);
  assert.ok(dep.build_log.includes('Downloaded'));
  assert.equal(dep.config_snapshot.image_ref, 'example/app:latest');
  assert.ok(!JSON.stringify(dep.config_snapshot).includes('do-not-snapshot'));
  assert.ok(!pool.queries.some(q => q.startsWith('SELECT * FROM repos')));
  assert.deepEqual(docker.createCalls[0].NetworkingConfig.EndpointsConfig.nixre.Aliases, [`nixre-svc-${svc.id}`]);
  assert.equal(docker.createCalls[0].HostConfig.PortBindings, undefined);
  await engine.stopService(svc.id);
  svc.image_ref = 'example/app:changed';
  await engine.startService(svc.id);
  assert.equal(svc.status, 'running', 'restart uses a fresh desired_state row, not the pre-update snapshot');
  assert.equal(docker.createCalls.at(-1).Image, dep.image_tag);
  assert.equal(docker.pullCalls.length, 1);
  await engine.redeploy(svc.id);
  await engine.waitAllIdle();
  assert.equal(docker.createCalls.at(-1).Image, dep.image_tag);
  assert.equal(pool.deployments.get(101).config_snapshot.image_ref, 'example/app:latest');
  assert.equal(pool.deployments.get(101).ref, 'example/app:latest', 'runtime apply retains the released image reference');
  assert.equal(pool.deployments.get(101).sha, '', 'image redeploy keeps the non-null empty SHA convention');
  assert.equal(docker.pullCalls.length, 1);
});

test('recreate persists intent before stopping and never overlaps database containers; volume survives stop/delete', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool, { ...postgres, current_deployment_id: 11, security_policy_version: 1 });
  pool.seedDeployment(11, { service_id: svc.id, image_tag: makeImageTag(svc.id, 11) });
  const docker = new FakeDocker();
  const old = docker.seedContainer(containerName(svc.id, 11), { labels: { 'nixre.service': String(svc.id) } });
  docker.beforeStop = () => {
    assert.equal(svc.desired_state, 'stopped');
    assert.equal(svc.current_deployment_id, null);
  };
  docker.beforeStart = () => {
    assert.equal(old.running, false);
    assert.equal(old.stops, 1);
    assert.equal(svc.desired_state, 'stopped');
    assert.equal(svc.current_deployment_id, null);
  };
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id);
  await engine.waitAllIdle();
  assert.equal(svc.status, 'running');
  assert.equal(svc.desired_state, 'running');
  assert.equal(svc.current_deployment_id, 100);
  const opts = docker.createCalls[0];
  assert.deepEqual(opts.HostConfig.Mounts, [{ Type: 'volume', Source: `nixre-service-${svc.id}-data`, Target: postgres.volume_path }]);
  assert.deepEqual(opts.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(opts.HostConfig.CapAdd, ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'KILL']);
  assert.deepEqual(opts.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(opts.HostConfig.Privileged, undefined);
  assert.deepEqual(opts.Healthcheck.Test, ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"']);
  assert.deepEqual(docker.volumeCreates[0].Labels, { 'nixre.deploy': 'true', 'nixre.service': String(svc.id) });
  docker.beforeStop = null;
  docker.beforeStart = null;
  await engine.stopService(svc.id);
  await engine.startService(svc.id);
  assert.equal(docker.volumeCreates.length, 1, 'existing owned volume reused');
  await engine.deleteDeployment(svc.id, 11);
  assert.equal(docker.volumes.size, 1, 'no lifecycle operation removes the retained volume');
  await assert.rejects(engine.rollback(svc.id, 11), /stateful/);
});

test('failed recreate stays stopped without a previous-image fallback, including boot sweep', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool, { ...postgres, current_deployment_id: 11 });
  pool.seedDeployment(11, { service_id: svc.id, image_tag: 'old-db:local' });
  const docker = new FakeDocker();
  docker.healthStatus = 'starting';
  const old = docker.seedContainer(containerName(svc.id, 11));
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id);
  await engine.waitAllIdle();
  assert.equal(pool.deployments.get(100).status, 'failed');
  assert.equal(svc.status, 'stopped');
  assert.equal(svc.desired_state, 'stopped');
  assert.equal(svc.current_deployment_id, null);
  assert.equal(old.stops, 1);
  assert.equal(docker.containers.size, 0);
  await engine.sweep();
  assert.equal(docker.createCalls.length, 1);
  await assert.rejects(engine.startService(svc.id), /deploy explicitly/);
  assert.equal(svc.desired_state, 'stopped');
  docker.healthStatus = 'healthy';
  await engine.startDeployment(svc.id);
  await engine.waitAllIdle();
  assert.equal(svc.status, 'running', 'explicit deploy can recover');
  assert.equal(docker.volumeCreates.length, 1);
});

test('a failed old-container stop prevents any candidate from starting', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool, { ...postgres, current_deployment_id: 11 });
  const docker = new FakeDocker();
  const old = docker.seedContainer(containerName(svc.id, 11), { labels: { 'nixre.service': String(svc.id) } });
  old.stopError = 'daemon refused stop';
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id);
  await engine.waitAllIdle();
  assert.equal(docker.createCalls.length, 0);
  assert.equal(old.running, true);
  assert.equal(old.removes, 0);
  assert.equal(svc.desired_state, 'stopped');
  assert.equal(svc.current_deployment_id, null);
  assert.match(pool.deployments.get(100).error, /refused stop/);
  old.stopError = null;
  await engine.sweep();
  assert.equal(old.running, false);
});

test('cancel during recreate readiness quiesces candidate and keeps durable stopped intent', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool, postgres);
  const docker = new FakeDocker();
  docker.healthStatus = 'starting';
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id);
  while (!docker.createCalls.length) await sleep(1);
  await engine.cancelDeployment(svc.id);
  await engine.waitAllIdle();
  assert.equal(pool.deployments.get(100).status, 'cancelled');
  assert.equal(svc.desired_state, 'stopped');
  assert.equal(svc.current_deployment_id, null);
  assert.equal(docker.containers.size, 0);
  assert.equal(docker.volumes.size, 1);
});

test('boot quiesces interrupted recreate candidates even after release became live but pointer stayed cleared', async () => {
  for (const status of ['releasing', 'live']) {
    const pool = new FakePool();
    const svc = addStandalone(pool, { ...postgres, desired_state: 'stopped', status: 'deploying' });
    pool.seedDeployment(50, { service_id: svc.id, status, image_tag: 'candidate:local' });
    pool.seedDeployment(11, { service_id: svc.id, image_tag: 'old:local' });
    const docker = new FakeDocker();
    const labels = { 'nixre.deploy': 'true', 'nixre.service': String(svc.id) };
    const candidate = docker.seedContainer(containerName(svc.id, 50), { labels });
    const old = docker.seedContainer(containerName(svc.id, 11), { labels });
    const { engine } = makeEngine(pool, { docker });
    await engine.sweep();
    assert.equal(candidate.running, false);
    assert.equal(old.running, false);
    assert.equal(docker.containers.size, 0);
    assert.equal(docker.createCalls.length, 0);
    assert.equal(svc.status, 'stopped');
  }
});

test('managed volumes fail closed on blue/green, invalid paths, collisions and unapproved templates', async () => {
  for (const fields of [{ volume_path: '/data', deployment_strategy: 'blue_green' },
    { volume_path: '../data' }, { ...postgres, image_ref: 'attacker/postgres:16' },
    { ...postgres, runtime_options: { host_config: { privileged: true } } },
    { runtime_options: { host_config: { network_mode: 'host' } } }]) {
    const pool = new FakePool();
    const svc = addStandalone(pool, fields);
    const docker = new FakeDocker();
    const { engine } = makeEngine(pool, { docker });
    await engine.startDeployment(svc.id);
    await engine.waitAllIdle();
    assert.equal(pool.deployments.get(100).status, 'failed');
    assert.equal(docker.createCalls.length, 0);
  }
  const pool = new FakePool();
  const svc = addStandalone(pool, postgres);
  const docker = new FakeDocker();
  docker.volumes.set(`nixre-service-${svc.id}-data`, { Labels: { 'nixre.service': 'other' } });
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id);
  await engine.waitAllIdle();
  assert.match(pool.deployments.get(100).error, /ownership/);
  assert.equal(docker.createCalls.length, 0);
  assert.equal(docker.volumes.size, 1);
});

test('external Git forwards source context, selected Dockerfile and target; always cleans up', async () => {
  for (const fail of [false, true]) {
    const pool = new FakePool();
    const svc = addStandalone(pool, { source_type: 'git', git_url: 'https://github.com/ggml-org/llama.cpp.git',
      root_dir: '.', dockerfile_path: '.devops/cpu.Dockerfile', build_target: 'server',
      runtime_options: { command: ['--model', '/models/model.gguf'], host_config: {
        binds: ['/srv/models:/models:ro'], gpus: 'all' } } });
    const docker = new FakeDocker();
    if (fail) docker.buildScript = () => ({ ok: false, error: 'build failed' });
    let cleanup = 0;
    let preparation;
    const { engine } = makeEngine(pool, { docker, drivers: {
      prepareExternalSource: async args => {
        preparation = args;
        return { sha: 'abc123', message: 'llama update', archive: async () => {
          const stream = new PassThrough(); stream.end('tar'); return stream;
        }, cleanup: async () => { cleanup++; } };
      },
      resolveRef: () => { throw new Error('must not use forge'); },
    } });
    await engine.startDeployment(svc.id);
    await engine.waitAllIdle();
    assert.equal(cleanup, 1);
    assert.equal(preparation.gitUrl, svc.git_url);
    assert.equal(preparation.rootDir, '.');
    assert.equal(preparation.dockerfilePath, '.devops/cpu.Dockerfile');
    assert.equal(docker.buildOptions[0].dockerfile, '.devops/cpu.Dockerfile');
    assert.equal(docker.buildOptions[0].target, 'server');
    assert.deepEqual(docker.buildOptions[0].buildargs, { TARGETARCH: 'amd64', TARGETPLATFORM: 'linux/amd64' });
    assert.equal(pool.deployments.get(100).sha, 'abc123');
    assert.equal(pool.deployments.get(100).config_snapshot.build_target, 'server');
    assert.ok(!pool.queries.some(q => q.startsWith('SELECT * FROM repos')));
    if (!fail) {
      assert.deepEqual(docker.createCalls[0].HostConfig.DeviceRequests,
        [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }]);
      assert.deepEqual(docker.createCalls[0].HostConfig.Binds, ['/srv/models:/models:ro']);
      assert.deepEqual(docker.createCalls[0].Cmd, ['--model', '/models/model.gguf']);
    }
  }
});

test('repo build forwards the selected context-relative Dockerfile and target', async () => {
  const pool = new FakePool();
  pool.addRepo('acme', 'mono');
  const svc = pool.addService({ root_dir: 'apps/server', dockerfile_path: 'build/Dockerfile.prod', build_target: 'prod' });
  const docker = new FakeDocker();
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id);
  await engine.waitAllIdle();
  assert.deepEqual(docker.buildOptions[0], { t: makeImageTag(svc.id, 100), dockerfile: 'build/Dockerfile.prod', target: 'prod' });
});

test('pull progress cancellation and timeout terminate the stream before candidate creation', async () => {
  for (const cancel of [false, true]) {
    const pool = new FakePool();
    const svc = addStandalone(pool);
    const docker = new FakeDocker();
    let stream;
    docker.pullScript = s => { stream = s; };
    const { engine } = makeEngine(pool, { docker, buildTimeoutMs: 20 });
    await engine.startDeployment(svc.id);
    if (cancel) {
      while (!stream) await sleep(1);
      await engine.cancelDeployment(svc.id);
    }
    await engine.waitAllIdle();
    assert.equal(stream.destroyed, true);
    assert.equal(docker.createCalls.length, 0);
    assert.equal(pool.deployments.get(100).status, cancel ? 'cancelled' : 'failed');
    if (!cancel) assert.match(pool.deployments.get(100).error, /timed out/);
  }
});

test('pull errors and excessive progress fail before cutover, even if the registry tag is cached', async () => {
  for (const excessive of [false, true]) {
    const pool = new FakePool();
    const svc = addStandalone(pool, { current_deployment_id: 11 });
    const docker = new FakeDocker();
    const old = docker.seedContainer(containerName(svc.id, 11));
    docker.seedImage(svc.image_ref);
    docker.pullScript = stream => stream.end(excessive ? 'x'.repeat(8_000_001) :
      JSON.stringify({ errorDetail: { message: 'Registry authentication failed' }, error: 'denied' }) + '\n');
    const { engine } = makeEngine(pool, { docker });
    await engine.startDeployment(svc.id);
    await engine.waitAllIdle();
    assert.equal(pool.deployments.get(100).status, 'failed');
    assert.equal(docker.createCalls.length, 0);
    assert.equal(old.running, true);
    assert.equal(old.stops, 0);
    assert.equal(svc.current_deployment_id, 11);
    assert.equal(svc.desired_state, 'running');
    assert.ok(!docker.images.has(makeImageTag(svc.id, 100)));
  }
});

test('external Git cancellation closes archive/build streams and cleans up the prepared source', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool, { source_type: 'git', git_url: 'https://github.com/example/app.git' });
  const docker = new FakeDocker();
  let archive;
  let cleanup = 0;
  const { engine } = makeEngine(pool, { docker, drivers: {
    prepareExternalSource: async () => ({ sha: 'abc', message: '',
      archive: async () => { archive = new PassThrough(); return archive; },
      cleanup: async () => { cleanup++; },
    }),
  } });
  await engine.startDeployment(svc.id);
  while (!archive) await sleep(1);
  await engine.cancelDeployment(svc.id);
  await engine.waitAllIdle();
  assert.equal(archive.destroyed, true);
  assert.equal(cleanup, 1);
  assert.equal(pool.deployments.get(100).status, 'cancelled');
  assert.equal(docker.createCalls.length, 0);
});

test('failed legacy builds rebuild on redeploy rather than reusing a tag that was never built', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});
  const docker = new FakeDocker();
  docker.buildScript = () => ({ ok: false, error: 'build failed' });
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id);
  await engine.waitAllIdle();
  docker.buildScript = () => ({ ok: true, lines: ['built'] });
  await engine.redeploy(svc.id, 100);
  await engine.waitAllIdle();
  assert.equal(docker.buildCalls.length, 2);
  assert.equal(svc.status, 'running');
});

test('stop/deploy/sweep serialize and same-tick starts cannot both register', async () => {
  const pool = new FakePool();
  pool.addRepo('a', 'b');
  const svc = pool.addService({});
  const docker = new FakeDocker();
  const { engine } = makeEngine(pool, { docker, drivers: { probeHttp: () => ({ signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) } });
  const starts = await Promise.allSettled([engine.startDeployment(svc.id), engine.startDeployment(svc.id)]);
  assert.equal(starts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(starts.find(r => r.status === 'rejected').reason.status, 409);
  await engine.sweep();
  assert.notEqual(pool.deployments.get(100).error, 'Interrupted by restart');
  const stopped = engine.stopService(svc.id);
  await assert.rejects(engine.startDeployment(svc.id), err => err.status === 409);
  await stopped;
  assert.equal(svc.status, 'stopped');
  assert.equal(docker.containers.size, 0);
  assert.equal(pool.deployments.size, 1);
});

test('sweep reserves a service before async reconciliation so a new deploy cannot race it', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool, { current_deployment_id: 11 });
  pool.seedDeployment(11, { service_id: svc.id, image_tag: 'stored:local' });
  const docker = new FakeDocker();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  docker.beforeStart = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const { engine } = makeEngine(pool, { docker });
  const sweep = engine.sweep();
  await started;
  await assert.rejects(engine.startDeployment(svc.id), err => err.status === 409);
  release();
  await sweep;
  assert.equal(svc.status, 'running');
});

test('sweep rechecks a stale queued/building/releasing snapshot after an owned run finishes', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool);
  const docker = new FakeDocker();
  let releaseHealth;
  const gate = new Promise(resolve => { releaseHealth = resolve; });
  const { engine, drivers } = makeEngine(pool, { docker, drivers: {
    probeHttp: () => async () => { await gate; return { ok: true }; },
  } });
  await engine.startDeployment(svc.id);
  while (!docker.createCalls.length) await sleep(1);
  let releaseSweep;
  drivers.getDocker = () => new Promise(resolve => { releaseSweep = () => resolve(docker); });
  const sweep = engine.sweep();
  while (!releaseSweep) await sleep(1);
  releaseHealth();
  await engine.waitAllIdle();
  const rec = docker.containers.get(docker.createCalls[0].name);
  releaseSweep();
  await sweep;
  assert.equal(pool.deployments.get(100).status, 'live');
  assert.equal(rec.stops, 0);
  assert.equal(rec.running, true);
});

test('internal/stopped services reject public proxy targets even when cached; internal probes still run', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool, { exposure: 'http' });
  const docker = new FakeDocker();
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id);
  await engine.waitAllIdle();
  assert.ok(await engine.findServiceTarget(svc.id));
  svc.exposure = 'internal';
  assert.equal(await engine.findServiceTarget(svc.id), null);
  assert.equal((await engine.probeTick())[0].ok, true);
  svc.exposure = 'http';
  svc.desired_state = 'stopped';
  assert.equal(await engine.findServiceTarget(svc.id), null);
});

test('native and TCP readiness are used both for release and ongoing internal checks', async () => {
  for (const health_type of ['docker', 'tcp']) {
    const pool = new FakePool();
    const svc = addStandalone(pool, { runtime_options: { health_type,
      ...(health_type === 'docker' ? { health_command: ['CMD', 'ready'] } : {}) } });
    const docker = new FakeDocker();
    let tcp = 0;
    const { engine } = makeEngine(pool, { docker, drivers: {
      probeHttp: () => { throw new Error('must not HTTP probe'); },
      probeTcp: () => async () => { tcp++; return { ok: true, status: null }; },
    } });
    await engine.startDeployment(svc.id);
    await engine.waitAllIdle();
    assert.equal(svc.status, 'running');
    assert.equal((await engine.probeTick())[0].ok, true);
    if (health_type === 'tcp') assert.equal(tcp, 2);
    else {
      assert.deepEqual(docker.createCalls[0].Healthcheck.Test, ['CMD', 'ready']);
      docker.containers.get(docker.createCalls[0].name).health = 'starting';
      assert.equal((await engine.probeTick())[0].ok, false);
    }
  }
});

test('release deletion checks child ownership and keeps images referenced by current/shared releases', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool, { current_deployment_id: 12 });
  const tag = makeImageTag(svc.id, 11);
  pool.seedDeployment(11, { service_id: svc.id, image_tag: tag });
  pool.seedDeployment(12, { service_id: svc.id, image_tag: tag });
  pool.seedDeployment(13, { service_id: 999, image_tag: 'other:local' });
  const docker = new FakeDocker();
  docker.seedImage(tag);
  const { engine } = makeEngine(pool, { docker });
  await assert.rejects(engine.deleteDeployment(svc.id, 13), err => err.status === 404);
  assert.ok(pool.deployments.has(13));
  await engine.deleteDeployment(svc.id, 11);
  assert.ok(docker.images.has(tag));
});

test('pruning keeps the current rollback image and never removes a shared registry reference', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool, { deployment_strategy: 'blue_green' });
  const docker = new FakeDocker();
  for (const id of [11, 12, 13]) {
    docker.seedImage(makeImageTag(svc.id, id));
    pool.seedDeployment(id, { service_id: svc.id, image_tag: makeImageTag(svc.id, id) });
  }
  docker.seedImage('example/app:latest');
  const { engine } = makeEngine(pool, { docker, keepImages: 1 });
  await engine.rollback(svc.id, 11);
  await engine.waitAllIdle();
  assert.ok(docker.images.has(makeImageTag(svc.id, 11)));
  assert.ok(docker.images.has('example/app:latest'));
  assert.ok(!docker.images.has(makeImageTag(svc.id, 12)));
});

test('runtime logs demultiplex stdout/stderr, bound tail and text, and tolerate missing containers', async () => {
  const pool = new FakePool();
  const svc = addStandalone(pool, { current_deployment_id: 11 });
  const docker = new FakeDocker();
  const rec = docker.seedContainer(containerName(svc.id, 11));
  const frame = (stream, text) => {
    const payload = Buffer.from(text);
    const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };
  rec.logs = Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')]);
  const { engine } = makeEngine(pool, { docker });
  assert.equal(await engine.runtimeLogs(svc.id), 'out\nerr\n');
  assert.equal(docker.logOptions.tail, 200);
  rec.tty = true;
  rec.logs = Buffer.from('x'.repeat(300_000));
  assert.equal((await engine.runtimeLogs(svc.id, { tail: 99999 })).length, 256_000);
  assert.equal(docker.logOptions.tail, 1000);
  docker.containers.clear();
  assert.equal(await engine.runtimeLogs(svc.id), '');
});

test('image releases satisfy the inherited SHA NOT NULL constraint with pg string IDs', { timeout: 2000 }, async t => {
  const pool = new FakePool({ pgIds: true });
  const svc = addStandalone(pool);
  pool.seedDeployment(11, { service_id: svc.id });
  await assert.rejects(pool.query('UPDATE deployments SET sha = $1 WHERE id = $2', [null, 11]),
    err => err.code === '23502');
  const docker = new FakeDocker();
  const { engine } = makeEngine(pool, { docker });
  const events = [];
  t.after(subscribe(String(svc.id), event => events.push(event)));
  events.length = 0;
  const result = await engine.startDeployment(svc.id);
  assert.equal(result.deploymentId, '100');
  await engine.waitIdle(String(svc.id));
  assert.equal(pool.deployments.get(100).status, 'live');
  assert.equal(pool.deployments.get(100).sha, '');
  assert.equal(svc.current_deployment_id, '100');
  assert.equal(engine.isBusy(svc.id), false, 'run is removed using the same canonical key it registered');
  assert.deepEqual(events.filter(e => e.type === 'status').map(e => e.status), ['queued', 'building', 'releasing', 'live']);
  await engine.redeploy(svc.id, 100);
  await engine.waitAllIdle();
  assert.equal(pool.deployments.get(101).sha, '');
});

test('pg string IDs protect current/foreign releases and allow owned rollback/redeploy/delete', { timeout: 2000 }, async () => {
  const pool = new FakePool({ pgIds: true });
  const svc = addStandalone(pool, { current_deployment_id: '11' });
  const currentTag = makeImageTag(svc.id, 11);
  const oldTag = makeImageTag(svc.id, 12);
  pool.seedDeployment(11, { service_id: svc.id, image_tag: currentTag });
  pool.seedDeployment(12, { service_id: svc.id, image_tag: oldTag });
  pool.seedDeployment(13, { service_id: 999, image_tag: 'foreign:local' });
  const docker = new FakeDocker();
  docker.seedImage(currentTag);
  docker.seedImage(oldTag);
  const current = docker.seedContainer(containerName(svc.id, 11));
  const { engine } = makeEngine(pool, { docker });
  for (const id of [svc.id, String(svc.id)]) {
    await assert.rejects(engine.deleteDeployment(id, 11), err => err.status === 400);
    await assert.rejects(engine.rollback(id, 11), err => err.status === 400);
    await assert.rejects(engine.deleteDeployment(id, 13), err => err.status === 404);
    await assert.rejects(engine.rollback(id, 13), err => err.status === 404);
    await assert.rejects(engine.redeploy(id, 13), err => err.status === 404);
  }
  assert.equal(current.removes, 0);
  assert.ok(docker.images.has(currentTag));
  await engine.rollback(svc.id, 12);
  await engine.waitAllIdle();
  assert.equal(svc.current_deployment_id, '100');
  await engine.redeploy(String(svc.id), 100);
  await engine.waitAllIdle();
  assert.equal(svc.current_deployment_id, '101');
  await engine.deleteDeployment(svc.id, 12);
  assert.equal(pool.deployments.has(12), false);
  assert.ok(docker.images.has(oldTag), 'shared current image is retained');
});

test('mixed numeric/string IDs share deploy, cancel, stop, sweep, auto-deploy and log state', { timeout: 2000 }, async () => {
  const pool = new FakePool({ pgIds: true });
  pool.addRepo('a', 'b');
  const svc = pool.addService({});
  const docker = new FakeDocker();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { engine } = makeEngine(pool, { docker, drivers: {
    probeHttp: () => async () => { await gate; return { ok: true }; },
  } });
  await engine.startDeployment(svc.id);
  while (!docker.createCalls.length) await sleep(1);
  assert.equal(engine.isBusy(String(svc.id)), true);
  await assert.rejects(engine.startDeployment(String(svc.id)), err => err.status === 409);
  await engine.sweep();
  assert.equal(pool.deployments.get(100).status, 'releasing');
  assert.equal(await engine.maybeAutoDeploy({ space: 'a', repo: 'b', branch: 'main' }), 0);
  const rec = docker.containers.get(docker.createCalls[0].name);
  rec.tty = true;
  rec.logs = Buffer.from('candidate logs');
  assert.equal(await engine.runtimeLogs(String(svc.id)), 'candidate logs');
  assert.equal(await engine.cancelDeployment(String(svc.id)), true);
  const stopped = engine.stopService(svc.id);
  await assert.rejects(engine.startDeployment(String(svc.id)), err => err.status === 409);
  release();
  await stopped;
  await engine.waitIdle(String(svc.id));
  assert.equal(pool.deployments.get(100).status, 'cancelled');
  assert.equal(svc.status, 'stopped');
  assert.equal(docker.containers.size, 0);
  assert.equal(engine.isBusy(svc.id), false);
});

test('pg string IDs share target invalidation, metric snapshots and stopped-service restart', { timeout: 2000 }, async () => {
  const pool = new FakePool({ pgIds: true });
  const svc = addStandalone(pool, { exposure: 'http' });
  const docker = new FakeDocker();
  const { engine } = makeEngine(pool, { docker });
  await engine.startDeployment(svc.id);
  await engine.waitAllIdle();
  const target = await engine.findServiceTarget(svc.id);
  const rec = docker.containers.get(docker.createCalls[0].name);
  rec.networks.nixre.IPAddress = '10.0.0.33';
  assert.deepEqual(await engine.findServiceTarget(String(svc.id)), target, 'both representations hit the same cache');
  engine.invalidateTarget(svc.id);
  assert.equal((await engine.findServiceTarget(String(svc.id))).ip, '10.0.0.33');
  await engine.metricsTick();
  assert.equal(engine.getStatsSnapshot(svc.id).series.length, 1);
  assert.deepEqual(engine.getStatsSnapshot(svc.id), engine.getStatsSnapshot(String(svc.id)));
  await engine.stopService(svc.id);
  await engine.startService(String(svc.id));
  assert.equal(svc.status, 'running');
  assert.equal(docker.pullCalls.length, 1);
});

test('pg string IDs preserve interrupted recreate recovery with a cleared current pointer', async () => {
  const pool = new FakePool({ pgIds: true });
  const svc = addStandalone(pool, { ...postgres, desired_state: 'stopped', status: 'deploying' });
  pool.seedDeployment(11, { service_id: svc.id, status: 'releasing' });
  const docker = new FakeDocker();
  const candidate = docker.seedContainer(containerName(svc.id, 11), {
    labels: { 'nixre.service': String(svc.id), 'nixre.deploy': 'true' },
  });
  const { engine } = makeEngine(pool, { docker });
  await engine.sweep();
  assert.equal(candidate.running, false);
  assert.equal(pool.deployments.get(11).status, 'failed');
  assert.equal(svc.current_deployment_id, null);
  await assert.rejects(engine.startService(svc.id), err => err.status === 409);
});

test('external Git builds pass daemon-derived target args for both supported architectures', async () => {
  for (const [architecture, target] of [['amd64', 'amd64'], ['x86_64', 'amd64'], ['arm64', 'arm64'], ['aarch64', 'arm64']]) {
    const pool = new FakePool();
    const svc = addStandalone(pool, { source_type: 'git', dockerfile_path: '.devops/cpu.Dockerfile', build_target: 'server' });
    const docker = new FakeDocker();
    docker.daemonInfo = { Architecture: architecture, OSType: 'linux' };
    const { engine } = makeEngine(pool, { docker, drivers: {
      prepareExternalSource: async () => ({ sha: 'abc123', message: '', archive: async () => {
        const stream = new PassThrough(); stream.end('tar'); return stream;
      }, cleanup: async () => {} }),
    } });
    await engine.startDeployment(svc.id);
    await engine.waitAllIdle();
    assert.equal(svc.status, 'running');
    assert.equal(docker.infoCalls, 1);
    assert.equal(docker.buildOptions[0].target, 'server');
    assert.equal(docker.buildOptions[0].dockerfile, '.devops/cpu.Dockerfile');
    assert.deepEqual(docker.buildOptions[0].buildargs, { TARGETARCH: target, TARGETPLATFORM: `linux/${target}` });
  }
});

test('external Git refuses unavailable/unsupported daemon architectures without guessing or cutting over', async () => {
  for (const info of [null, {}, { Architecture: 'riscv64', OSType: 'linux' }, { Architecture: 'amd64', OSType: 'windows' }, 'unavailable']) {
    const pool = new FakePool();
    const svc = addStandalone(pool, { source_type: 'git', current_deployment_id: 11 });
    const docker = new FakeDocker();
    docker.daemonInfo = info;
    if (info === 'unavailable') docker.info = async () => { throw new Error('unavailable'); };
    const old = docker.seedContainer(containerName(svc.id, 11));
    let cleanup = 0;
    const { engine } = makeEngine(pool, { docker, drivers: {
      prepareExternalSource: async () => ({ sha: 'abc123', message: '',
        archive: async () => { throw new Error('must not archive'); }, cleanup: async () => { cleanup++; } }),
    } });
    await engine.startDeployment(svc.id);
    await engine.waitAllIdle();
    assert.match(pool.deployments.get(100).error, /Docker daemon.*architecture/);
    assert.equal(docker.buildCalls.length, 0);
    assert.equal(cleanup, 1);
    assert.equal(old.stops, 0);
    assert.equal(old.running, true);
  }
});

test('hosted repo builds, image pulls and stored-image releases keep working without daemon architecture lookup', async () => {
  for (const source_type of ['repo', 'image', 'git']) {
    const pool = new FakePool();
    pool.addRepo('a', 'b');
    const svc = source_type === 'repo' ? pool.addService({}) : addStandalone(pool, { source_type });
    const docker = new FakeDocker();
    docker.daemonInfo = null;
    const { engine } = makeEngine(pool, { docker });
    await engine.startDeployment(svc.id, source_type === 'git' ? { _reuseImage: 'stored:local' } : {});
    await engine.waitAllIdle();
    assert.equal(svc.status, 'running');
    assert.equal(docker.infoCalls, 0);
    if (source_type === 'repo') assert.equal(docker.buildOptions[0].buildargs, undefined);
  }
});

test('stable aliases are only attached to recreate services on create and boot network reconciliation', async () => {
  for (const deployment_strategy of [undefined, 'blue_green', 'recreate']) {
    const pool = new FakePool();
    pool.addRepo('a', 'b');
    const svc = pool.addService({ deployment_strategy });
    const docker = new FakeDocker();
    const { engine } = makeEngine(pool, { docker });
    const expected = deployment_strategy === 'recreate' ? [`nixre-svc-${svc.id}`] : undefined;
    await engine.startDeployment(svc.id);
    await engine.waitAllIdle();
    assert.equal(svc.status, 'running');
    assert.deepEqual(docker.createCalls[0].NetworkingConfig.EndpointsConfig.nixre.Aliases, expected);
    const rec = docker.containers.get(docker.createCalls[0].name);
    rec.networks = { old_network: { IPAddress: rec.ip } };
    await engine.sweep();
    assert.deepEqual(rec.networks.nixre.Aliases, expected);
    assert.equal(rec.removes, 0, 'network migration preserves the existing container');
  }
});
