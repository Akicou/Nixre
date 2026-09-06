import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import callbackDns from 'node:dns';
import http from 'node:http';
import { once } from 'node:events';
import { isPrivateAddress, assertPublicUrl, guardedFetch, NetPolicyError } from './netGuard.js';

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('CIDRs include mapped IPv6 and full link-local range, not adjacent public blocks', () => {
  for (const ip of [
    '0.1.2.3', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '172.31.255.255', '192.168.1.1', '100.64.0.1', '198.18.0.1', '224.0.0.1',
    '192.0.0.8', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::', '::1',
    '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
    'fe80::1', 'fe90::1', 'febf::1', 'fc00::1', 'fd00::1', 'ff02::1', '2001:db8::1',
    '64:ff9b::7f00:1', '2002:7f00:1::', '2001:2::1', '2001:10::1', '2001:20::1', '3fff::1', 'invalid',
  ]) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '192.0.78.24', '192.0.0.9', '192.0.0.10',
    '172.15.255.255', '172.32.0.1', '192.175.48.1', '192.31.196.1',
    '2606:4700:4700::1111', '2001:3::1', '2001:4:112::1', '::ffff:808:808']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('invalid URLs and blocked addresses have typed policy errors', async () => {
  for (const url of ['invalid', 'file:///etc/passwd', 'http://user:pass@example.com',
    'http://localhost', 'http://metadata.google.internal', 'http://[::ffff:127.0.0.1]',
    'http://[::ffff:a9fe:a9fe]', 'http://[fe90::1]']) {
    const result = await assertPublicUrl(url);
    assert.equal(result.ok, false, url);
    assert.ok(result.error instanceof NetPolicyError, url);
  }
});

test('mapped IPv6 cannot reach a real private listener', async t => {
  let hits = 0;
  const origin = await serverFor(t, (_req, res) => { hits++; res.end('private'); });
  await assert.rejects(guardedFetch(origin.replace('127.0.0.1', '[::ffff:127.0.0.1]')), NetPolicyError);
  assert.equal(hits, 0);
});

test('DNS validation rejects mixed address sets; transient failures are not policy errors', async t => {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  await assert.rejects(guardedFetch('http://mixed.invalid'), NetPolicyError);
  dns.lookup = async () => { throw Object.assign(new Error('temporary'), { code: 'EAI_AGAIN' }); };
  await assert.rejects(guardedFetch('http://mixed.invalid'), error => error.code === 'EAI_AGAIN' && !(error instanceof NetPolicyError));
});

test('transport uses only the validated lookup and preserves the origin Host', async t => {
  let seenHost;
  const local = await serverFor(t, (req, res) => { seenHost = req.headers.host; res.end('pinned'); });
  const origin = local.replace('127.0.0.1', 'pinned.invalid');
  let checks = 0;
  t.mock.method(dns, 'lookup', async () => { checks++; return [{ address: '127.0.0.1', family: 4 }]; });
  t.mock.method(callbackDns, 'lookup', () => { throw new Error('Unexpected second DNS resolution'); });
  const response = await guardedFetch(origin, { headers: { Host: 'evil.invalid' } }, { allowedPrivateOrigins: [origin] });
  assert.equal(await response.text(), 'pinned');
  assert.equal(seenHost, new URL(origin).host);
  assert.equal(checks, 1);
});

test('private exceptions are exact caller-supplied origins, not a global exemption', async t => {
  const origin = await serverFor(t, (_req, res) => res.end('ok'));
  assert.equal(await (await guardedFetch(origin, {}, { allowedPrivateOrigins: [origin] })).text(), 'ok');
  await assert.rejects(guardedFetch(origin), NetPolicyError);
  await assert.rejects(guardedFetch(origin, {}, { allowedPrivateOrigins: [`${origin}/path`] }), NetPolicyError);
  await assert.rejects(guardedFetch(origin, {}, { allowedPrivateOrigins: ['http://127.0.0.1'] }), NetPolicyError);
});

test('redirects revalidate targets and cannot extend an allowlisted origin', async t => {
  let hits = 0;
  const target = await serverFor(t, (_req, res) => { hits++; res.end('private'); });
  const origin = await serverFor(t, (_req, res) => { res.writeHead(302, { location: target }); res.end(); });
  await assert.rejects(guardedFetch(origin, {}, { allowedPrivateOrigins: [origin] }), NetPolicyError);
  assert.equal(hits, 0);
});

test('redirect count is bounded and POST semantics distinguish 303 from 307', async t => {
  const requests = [];
  const origin = await serverFor(t, (req, res) => {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url, method: req.method, text });
      if (req.url === '/loop') res.writeHead(302, { location: '/loop' });
      if (req.url === '/303' || req.url === '/307') res.writeHead(Number(req.url.slice(1)), { location: '/final' });
      res.end('ok');
    });
  });
  const policy = { allowedPrivateOrigins: [origin], maxRedirects: 2 };
  await assert.rejects(guardedFetch(`${origin}/loop`, {}, policy), /Too many redirects/);
  assert.equal(requests.length, 3);
  for (const status of [303, 307]) {
    const response = await guardedFetch(`${origin}/${status}`, { method: 'POST', body: 'payload' }, policy);
    await response.text();
    assert.equal(response.redirected, true);
    assert.equal(response.url, `${origin}/final`);
    assert.deepEqual(requests.at(-1), { path: '/final', method: status === 303 ? 'GET' : 'POST', text: status === 303 ? '' : 'payload' });
  }
});

test('cross-origin redirect strips credentials', async t => {
  let headers;
  const target = await serverFor(t, (req, res) => { headers = req.headers; res.end('ok'); });
  const origin = await serverFor(t, (_req, res) => { res.writeHead(307, { location: target }); res.end(); });
  await (await guardedFetch(origin, { headers: { Authorization: 'Bearer secret', Cookie: 'secret', 'x-api-key': 'secret' } },
    { allowedPrivateOrigins: [origin, target] })).text();
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers['x-api-key'], undefined);
});

test('caller cancellation remains active after headers for a streaming response', async t => {
  const origin = await serverFor(t, (_req, res) => { res.writeHead(200); res.write('first'); });
  const controller = new AbortController();
  const response = await guardedFetch(origin, { signal: controller.signal }, { timeoutMs: 0, allowedPrivateOrigins: [origin] });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  controller.abort();
  await assert.rejects(reader.read());
});

test('one deadline covers DNS and response body, not just response headers', async t => {
  const origin = await serverFor(t, (_req, res) => { res.writeHead(200); res.write('first'); });
  const response = await guardedFetch(origin, {}, { timeoutMs: 50, allowedPrivateOrigins: [origin] });
  await assert.rejects(response.text());
  t.mock.method(dns, 'lookup', () => new Promise(() => {}));
  await assert.rejects(guardedFetch('http://slow.invalid', {}, { timeoutMs: 20 }), error => error.name === 'TimeoutError');
});
