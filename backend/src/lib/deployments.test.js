// Deployment lifecycle orchestration — hermetic tests. The engine gets a fake
// DB pool (in-memory tables interpreting its exact SQL), a FakeDocker that
// mirrors the dockerode surface it touches, and scripted IO drivers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import { createDeploymentEngine } from './deployments.js';
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
  constructor() {
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

  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, ' ').trim();
    this.queries.push(q);

    if (q === 'SELECT * FROM deploy_services WHERE id = $1') {
      const row = this.services.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (
      q.startsWith('SELECT s.* FROM deploy_services s JOIN repos r ON r.id = s.repo_id')
    ) {
      const out = [...this.services.values()].filter(svc => {
        const repo = [...this.repos.values()].find(r => r.id === svc.repo_id);
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
      const d = this.deployments.get(params[0]);
      return { rows: d ? [{ ...d }] : [] };
    }
    if (q === 'DELETE FROM deployments WHERE id = $1') {
      return { rowCount: this.deployments.delete(params[0]) ? 1 : 0 };
    }
    if (q === 'SELECT * FROM repos WHERE id = $1') {
      const repo = [...this.repos.values()].find(r => r.id === params[0]);
      return { rows: repo ? [repo] : [] };
    }
    if (q === 'SELECT key, value_enc FROM service_env_vars WHERE service_id = $1 ORDER BY key') {
      const kvs = this.envVars.get(params[0]) || new Map();
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
      return { rows: [...this.services.values()] };
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
      this.uptime = this.uptime.filter(u => !(u.service_id === params[0] && u.ts < params[1]));
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
      return row.service_id === p[0] && row.ts < p[1] && (row.status_code ?? 999) < p[2];
    }
    const failShape =
      /service_id = \$1 AND ts < \$2 AND \(status_code >= \$3 OR status_code IS NULL\)/.test(q);
    if (failShape) {
      return (
        row.service_id === p[0] &&
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
    const row = table.get(params[idIdx]);
    if (!row) return { rowCount: 0 };
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
    this.buildScript = () => ({ ok: true, lines: ['Step 1/1 : DONE'] });
    this.createCalls = [];
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
    };
    this.containers.set(name, rec);
    return rec;
  }

  seedImage(tag) {
    this.images.add(tag);
  }

  async ping() {}

  async buildImage(stream, opts) {
    this.buildCalls.push(opts.t);
    await new Promise(resolve => {
      stream.on('data', () => {});
      stream.on('end', resolve);
      stream.on('error', resolve);
    });
    const out = this.buildScript();
    const pt = new PassThrough();
    if (!out.ok) pt.end(JSON.stringify({ error: out.error }) + '\n');
    else pt.end(out.lines.map(l => JSON.stringify({ stream: l }) + '\n').join(''));
    return pt;
  }

  async createContainer(opts) {
    this.createCalls.push(opts);
    const rec = this.seedContainer(opts.name, { labels: opts.Labels });
    return this.getContainer(opts.name);
    void rec;
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
        State: { Status: rec.running ? 'running' : 'exited' },
        NetworkSettings: { Networks: { nixre: { IPAddress: rec.ip } } },
        Labels: rec.labels,
      }),
      start: async () => {
        rec.starts++;
        rec.running = true;
      },
      stop: async () => {
        rec.stops++;
        rec.running = false;
      },
      remove: async () => {
        rec.removes++;
        this.containers.delete(name);
      },
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

  getImage(tag) {
    return {
      inspect: async () => {
        if (!this.images.has(tag)) {
          const err = new Error('no such image');
          err.statusCode = 404;
          throw err;
        }
        return {};
      },
      remove: async () => {
        this.images.delete(tag);
      },
    };
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
