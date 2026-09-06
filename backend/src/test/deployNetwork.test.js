import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnedContainerNetwork, DATA_NETWORK } from '../lib/dockerNetwork.js';
import { assertSafeRef } from '../lib/deployDrivers.js';

function dockerFor(network, memberships = { apps: { NetworkID: 'apps-id' } }) {
  return {
    getNetwork() { return { inspect: async () => network }; },
    getContainer() { return { inspect: async () => ({ NetworkSettings: { Networks: memberships } }) }; },
  };
}

test('requires explicit existing network with core membership', async () => {
  const docker = dockerFor({ Name: 'apps', Id: 'apps-id', Driver: 'bridge' });
  assert.equal(await spawnedContainerNetwork(docker, { preferred: 'apps' }), 'apps');
  assert.equal(await spawnedContainerNetwork(docker, { preferred: 'apps-id' }), 'apps');
  await assert.rejects(spawnedContainerNetwork(docker, { preferred: '' }), /explicit/);
  await assert.rejects(spawnedContainerNetwork(null, { preferred: 'apps' }), /explicit/);
  await assert.rejects(spawnedContainerNetwork(dockerFor({ Name: 'apps', Id: 'other' }), { preferred: 'apps' }), /Core must be attached/);
  await assert.rejects(spawnedContainerNetwork({ getNetwork() { throw new Error('not found'); } }, { preferred: 'missing' }), /not found/);
});

test('database name, actual compose names, labels, and IDs cannot bypass exclusion', async () => {
  for (const network of [
    { Name: DATA_NETWORK, Id: 'data-id' },
    { Name: 'nixre_nixre-data', Id: 'data-id' },
    { Name: 'forge_nixre-data', Id: 'data-id' },
    { Name: 'renamed-data', Id: 'data-id', Labels: { 'com.docker.compose.network': 'nixre-data' } },
    { Name: 'host', Id: 'host-id', Driver: 'host' },
    { Name: 'bridge', Id: 'bridge-id', Driver: 'bridge' },
  ]) {
    await assert.rejects(spawnedContainerNetwork(dockerFor(network), { preferred: network.Id }), /Refusing unsafe/);
  }
});

test('assertSafeRef rejects flags, control characters and empty refs', () => {
  for (const value of ['--upload-pack=evil', '-x', '', ' ', 'main\n--evil', 'a'.repeat(401)]) {
    assert.throws(() => assertSafeRef(value));
  }
  for (const value of ['main', 'refs/heads/feature/x', 'v1.2.3', 'a1b2c3d']) assert.equal(assertSafeRef(value), value);
});
