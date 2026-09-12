import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { probeTcp, prepareExternalSource } from './deployDrivers.js';
import { prepareExternalSource as externalSource } from './deployGit.js';

test('production driver binds the shared external Git helper', () => {
  assert.equal(prepareExternalSource, externalSource);
});

test('TCP probes connect to the configured port and reject a closed port', async () => {
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.deepEqual(await probeTcp()({ host: '127.0.0.1', port, timeoutMs: 1000 }), { ok: true, status: null });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  await assert.rejects(probeTcp()({ host: '127.0.0.1', port, timeoutMs: 1000 }));
});

test('TCP probes respect an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(probeTcp()({ host: '127.0.0.1', port: 1, signal: controller.signal }),
    err => err.name === 'AbortError');
});
