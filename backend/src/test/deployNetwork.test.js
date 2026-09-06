// Network + hardening policy for containers core spawns.
//
// Regression: both the agent sandbox and the deployment engine picked core's
// network with `Object.keys(NetworkSettings.Networks)[0]`. Key order is not
// guaranteed, and once Postgres had its own internal network that expression
// had a real chance of returning the DATABASE network — putting user-supplied
// code (a Dockerfile only needs space write access) directly next to Postgres.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnedContainerNetwork, DATA_NETWORK } from '../lib/dockerNetwork.js';
import { assertSafeRef } from '../lib/deployDrivers.js';

// Mirrors dockerode: getContainer() is synchronous and returns an object with
// an async inspect().
function fakeDocker(networks) {
  return {
    getContainer() {
      return {
        async inspect() {
          return { NetworkSettings: { Networks: Object.fromEntries(networks.map(n => [n, {}])) } };
        },
      };
    },
  };
}

test('never returns the database network', async () => {
  // Worst case: the data network happens to be listed first.
  const docker = fakeDocker([DATA_NETWORK, 'nixre-app', 'nixre-apps']);
  const net = await spawnedContainerNetwork(docker, { role: 'app' });
  assert.notEqual(net, DATA_NETWORK, 'must not attach to the database network');
  assert.equal(net, 'nixre-app');
});

test('prefers the operator-configured network', async () => {
  const docker = fakeDocker([DATA_NETWORK, 'nixre-app']);
  const net = await spawnedContainerNetwork(docker, { preferred: 'nixre-apps', role: 'app' });
  assert.equal(net, 'nixre-apps');
});

test('refuses an explicit request for the database network', async () => {
  const docker = fakeDocker([DATA_NETWORK, 'nixre-app']);
  const net = await spawnedContainerNetwork(docker, {
    preferred: DATA_NETWORK,
    role: 'sandbox',
  });
  assert.equal(net, '', 'a misconfiguration must fail closed, not attach to the DB');
});

test('returns empty when core is only on the data network', async () => {
  const docker = fakeDocker([DATA_NETWORK]);
  const net = await spawnedContainerNetwork(docker, { role: 'app' });
  assert.equal(net, '', 'no safe network available -> fall back to daemon default');
});

test('returns empty without docker rather than guessing', async () => {
  assert.equal(await spawnedContainerNetwork(null, { role: 'app' }), '');
});

test('handles a docker that throws', async () => {
  const docker = {
    getContainer() {
      return {
        async inspect() {
          throw new Error('no such container');
        },
      };
    },
  };
  assert.equal(await spawnedContainerNetwork(docker, { role: 'app' }), '');
});

// --- git ref validation -------------------------------------------------------

test('assertSafeRef rejects option-shaped refs', () => {
  // A leading `-` makes git read the value as a flag rather than a revision.
  for (const bad of ['--upload-pack=evil', '-x', '--output=/tmp/pwned', '-']) {
    assert.throws(() => assertSafeRef(bad), /may not start with '-'/, `should reject ${bad}`);
  }
});

test('assertSafeRef rejects empty, control-char and overlong refs', () => {
  assert.throws(() => assertSafeRef(''), /required/);
  assert.throws(() => assertSafeRef('   '), /required/);
  assert.throws(() => assertSafeRef('main\n--evil'), /control characters/);
  assert.throws(() => assertSafeRef('a'.repeat(401)), /too long/);
});

test('assertSafeRef accepts ordinary refs', () => {
  for (const good of ['main', 'refs/heads/feature/x', 'v1.2.3', 'a1b2c3d']) {
    assert.equal(assertSafeRef(good), good);
  }
  // Trims surrounding whitespace.
  assert.equal(assertSafeRef('  main  '), 'main');
});
