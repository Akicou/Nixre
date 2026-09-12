import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { buildRoutes, createDeployProxy } from './deployProxy.js';

test('internal services never receive custom, vanity or deterministic HTTP routes', async () => {
  const services = [{ id: 1, name: 'db', exposure: 'internal' }, { id: 2, name: 'web', exposure: 'http' },
    { id: 3, name: 'web', exposure: 'internal' }, { id: 4, name: 'legacy' }];
  const domains = [{ domain: 'db.example.com', service_id: 1, verified: true },
    { domain: 'stopped-db.example.com', service_id: 9, verified: true, exposure: 'internal' },
    { domain: 'web.example.com', service_id: 2, verified: true, exposure: 'http' }];
  const routes = buildRoutes(domains, services, 'apps.example.com');
  assert.deepEqual(routes.map(r => r.host).sort(), ['web.example.com', 'web.apps.example.com', 'svc-2.apps.example.com', 'legacy.apps.example.com', 'svc-4.apps.example.com'].sort());
  let targets = 0;
  const proxy = createDeployProxy({ pool: { async query(sql) {
    assert.ok(sql.includes("exposure = 'http'"));
    return { rows: sql.includes('SELECT d.domain') ? domains : services };
  } }, engine: { async findServiceTarget() { targets++; return null; } } });
  assert.equal((await proxy.routeHost('db.example.com')).matched, false);
  assert.equal((await proxy.routeHost('stopped-db.example.com')).matched, false);
  assert.equal(targets, 0);
});

test('WebSocket connection refusal closes the client without an unhandled error', async t => {
  const placeholder = net.createServer();
  placeholder.listen(0, '127.0.0.1');
  await once(placeholder, 'listening');
  const closedPort = placeholder.address().port;
  await new Promise(resolve => placeholder.close(resolve));
  const proxy = createDeployProxy({
    pool: { query: async sql => ({ rows: sql.includes('SELECT d.domain')
      ? [{ domain: 'app.example.com', service_id: 1, verified: true }] : [] }) },
    engine: { findServiceTarget: async () => ({ ip: '127.0.0.1', port: closedPort }) },
  });
  await proxy.listen(0, '127.0.0.1');
  t.after(() => proxy.stop());
  const socket = net.connect(proxy.server.address().port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  socket.write('GET / HTTP/1.1\r\nHost: app.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  await closed;
  const response = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxy.server.address().port}/_nixre_healthz`, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  assert.equal(response, 200);
});

test('WebSocket upstream connection has a bounded deadline', async t => {
  const proxy = createDeployProxy({
    pool: { query: async sql => ({ rows: sql.includes('SELECT d.domain')
      ? [{ domain: 'app.example.com', service_id: 1, verified: true }] : [] }) },
    engine: { findServiceTarget: async () => ({ ip: '127.0.0.1', port: 9 }) },
  });
  await proxy.listen(0, '127.0.0.1');
  t.after(() => proxy.stop());
  let connected;
  const attempted = new Promise(resolve => { connected = resolve; });
  const pending = new net.Socket();
  t.mock.method(net, 'connect', () => { connected(); return pending; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new net.Socket();
  t.after(() => client.destroy());
  client.connect(proxy.server.address().port, '127.0.0.1');
  await once(client, 'connect');
  const closed = once(client, 'close');
  client.write('GET / HTTP/1.1\r\nHost: app.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  await attempted;
  t.mock.timers.tick(5001);
  await closed;
  assert.equal(pending.destroyed, true);
  assert.equal(proxy.server.listening, true);
});
