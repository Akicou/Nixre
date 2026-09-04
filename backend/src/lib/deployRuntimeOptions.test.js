// deployRuntimeOptions — hermetic unit tests for validation, normalization,
// and the fail-closed policy gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRuntimeOptions,
  getRuntimeOptions,
  parseBindAllowlist,
  runtimeFlagsFromEnv,
} from './deployRuntimeOptions.js';

const ADMIN = {
  admin: true,
  env: { NIXRE_DEPLOY_BIND_ALLOWLIST: '/var/run/docker.sock,/var/lib/sandbox' },
};

test('defaults normalize to a stable shape', () => {
  const out = normalizeRuntimeOptions(undefined, ADMIN);
  assert.equal(out.version, 1);
  assert.equal(out.health_path, '/');
  assert.equal(out.health_timeout_ms, null);
  assert.equal(out.command, null);
  assert.deepEqual(out.host_config.binds, []);
  assert.equal(out.host_config.privileged, false);
  assert.equal(out.host_config.network_mode, null);
  assert.deepEqual(Object.keys(out.host_config).sort(), [
    'binds',
    'cap_add',
    'cap_drop',
    'devices',
    'extra_hosts',
    'group_add',
    'network_mode',
    'privileged',
    'shm_size',
    'tmpfs',
  ]);
});

test('binds are accepted when allowlisted and admin', () => {
  const out = normalizeRuntimeOptions(
    { host_config: { binds: ['/var/run/docker.sock:/var/run/docker.sock', '/var/lib/sandbox/ws:/workspace:rw'] } },
    ADMIN,
  );
  assert.deepEqual(out.host_config.binds, [
    '/var/run/docker.sock:/var/run/docker.sock',
    '/var/lib/sandbox/ws:/workspace:rw',
  ]);
});

test('binds outside the allowlist are rejected', () => {
  assert.throws(
    () =>
      normalizeRuntimeOptions(
        { host_config: { binds: ['/etc:/etc:ro'] } },
        ADMIN,
      ),
    /not on the bind allowlist/,
  );
});

test('binds without any allowlist fail closed even for admins', () => {
  assert.throws(
    () =>
      normalizeRuntimeOptions(
        { host_config: { binds: ['/tmp:/tmp'] } },
        { admin: true, env: {} },
      ),
    /bind mounts are disabled/,
  );
});

test('binds require admin even with an allowlist', () => {
  assert.throws(
    () =>
      normalizeRuntimeOptions(
        { host_config: { binds: ['/var/run/docker.sock:/var/run/docker.sock'] } },
        { admin: false, env: ADMIN.env },
      ),
    /require instance admin/,
  );
});

test('allowlist entries cover subpaths but not siblings', () => {
  assert.throws(
    () =>
      normalizeRuntimeOptions(
        { host_config: { binds: ['/var/lib/sandboxev:/x'] } },
        ADMIN,
      ),
    /not on the bind allowlist/,
  );
  const ok = normalizeRuntimeOptions(
    { host_config: { binds: ['/var/lib/sandbox/deep/dir:/x:ro'] } },
    ADMIN,
  );
  assert.deepEqual(ok.host_config.binds, ['/var/lib/sandbox/deep/dir:/x:ro']);
});

test('binds reject relative paths and traversal', () => {
  assert.throws(
    () => normalizeRuntimeOptions({ host_config: { binds: ['relative:/x'] } }, ADMIN),
    /absolute path/,
  );
  assert.throws(
    () => normalizeRuntimeOptions({ host_config: { binds: ['/var/lib/sandbox/../etc:/x'] } }, ADMIN),
    /\.\./,
  );
});

test('privileged is gated on env flag + admin', () => {
  assert.throws(
    () => normalizeRuntimeOptions({ host_config: { privileged: true } }, ADMIN),
    /NIXRE_DEPLOY_ALLOW_PRIVILEGED/,
  );
  const ok = normalizeRuntimeOptions(
    { host_config: { privileged: true } },
    { ...ADMIN, env: { ...ADMIN.env, NIXRE_DEPLOY_ALLOW_PRIVILEGED: 'true' } },
  );
  assert.equal(ok.host_config.privileged, true);
});

test('network_mode=host is gated; bridge/none pass for admins', () => {
  assert.throws(
    () => normalizeRuntimeOptions({ host_config: { network_mode: 'host' } }, ADMIN),
    /NIXRE_DEPLOY_ALLOW_HOST_NETWORK/,
  );
  const ok = normalizeRuntimeOptions(
    { host_config: { network_mode: 'host' } },
    { ...ADMIN, env: { ...ADMIN.env, NIXRE_DEPLOY_ALLOW_HOST_NETWORK: '1' } },
  );
  assert.equal(ok.host_config.network_mode, 'host');
  const none = normalizeRuntimeOptions({ host_config: { network_mode: 'none' } }, ADMIN);
  assert.equal(none.host_config.network_mode, 'none');
  assert.throws(
    () => normalizeRuntimeOptions({ host_config: { network_mode: 'jail' } }, ADMIN),
    /network_mode/,
  );
});

test('capabilities, groups, extra hosts, shm and tmpfs normalize', () => {
  const out = normalizeRuntimeOptions(
    {
      health_path: '/healthz',
      health_timeout_ms: 45_000,
      command: 'python -u server.py',
      entrypoint: ['/bin/sh', '-c'],
      host_config: {
        cap_add: ['net_admin', 'SYS_TIME'],
        cap_drop: ['chown'],
        devices: ['/dev/kvm'],
        group_add: ['998', 34],
        extra_hosts: ['db:10.0.0.5'],
        shm_size: 256 * 1024 * 1024,
        tmpfs: { '/run': 'rw,size=64m' },
      },
    },
    ADMIN,
  );
  assert.equal(out.health_path, '/healthz');
  assert.equal(out.health_timeout_ms, 45_000);
  assert.deepEqual(out.command, ['python', '-u', 'server.py']);
  assert.deepEqual(out.entrypoint, ['/bin/sh', '-c']);
  assert.deepEqual(out.host_config.cap_add, ['NET_ADMIN', 'SYS_TIME']);
  assert.deepEqual(out.host_config.cap_drop, ['CHOWN']);
  assert.deepEqual(out.host_config.devices, ['/dev/kvm:/dev/kvm:rwm']);
  assert.deepEqual(out.host_config.group_add, [998, 34]);
  assert.deepEqual(out.host_config.extra_hosts, ['db:10.0.0.5']);
  assert.equal(out.host_config.shm_size, 256 * 1024 * 1024);
  assert.deepEqual(out.host_config.tmpfs, { '/run': 'rw,size=64m' });
});

test('unknown fields are rejected with the offending key', () => {
  assert.throws(
    () => normalizeRuntimeOptions({ volumez: [] }, ADMIN),
    /unknown field 'volumez'/,
  );
  assert.throws(
    () => normalizeRuntimeOptions({ host_config: { pid: 1 } }, ADMIN),
    /unknown field 'host_config\.pid'/,
  );
});

test('health path and timeout bounds are enforced', () => {
  assert.throws(() => normalizeRuntimeOptions({ health_path: 'health' }, ADMIN), /must start with/);
  assert.throws(
    () => normalizeRuntimeOptions({ health_timeout_ms: 100 }, ADMIN),
    /between 1000 and 600000/,
  );
});

test('getRuntimeOptions never throws on garbage and preserves good data', () => {
  assert.equal(getRuntimeOptions({ runtime_options: null }), null);
  assert.equal(getRuntimeOptions({ runtime_options: 'not json' }), null);
  assert.equal(getRuntimeOptions({ runtime_options: 42 }), null);
  assert.equal(getRuntimeOptions({}), null);

  const good = normalizeRuntimeOptions(
    { health_path: '/health', host_config: { binds: ['/var/run/docker.sock:/var/run/docker.sock'] } },
    ADMIN,
  );
  const parsed = getRuntimeOptions({ runtime_options: JSON.stringify(good) });
  assert.equal(parsed.health_path, '/health');
  assert.deepEqual(parsed.host_config.binds, ['/var/run/docker.sock:/var/run/docker.sock']);
  // Object form (what pg returns for JSONB) reads the same.
  const obj = getRuntimeOptions({ runtime_options: good });
  assert.deepEqual(obj.host_config.binds, parsed.host_config.binds);
});

test('env policy parsing', () => {
  const flags = runtimeFlagsFromEnv({
    NIXRE_DEPLOY_BIND_ALLOWLIST: ' /a , /var/run/docker.sock/ , ',
    NIXRE_DEPLOY_ALLOW_PRIVILEGED: 'true',
    NIXRE_DEPLOY_ALLOW_HOST_NETWORK: 'no',
  });
  assert.deepEqual(flags.bindAllowlist, ['/a', '/var/run/docker.sock']);
  assert.equal(flags.allowPrivileged, true);
  assert.equal(flags.allowHostNetwork, false);
  assert.deepEqual(parseBindAllowlist(''), []);
});
