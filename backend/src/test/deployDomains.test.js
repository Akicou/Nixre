import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import dns from 'node:dns/promises';
import express from 'express';
import { deploymentRoutes } from '../routes/deployments.js';
import { buildRoutes } from '../lib/deployProxy.js';
import { createTunnelCname } from '../lib/cloudflareDns.js';

async function fixture(t, { admin = false } = {}) {
  const previous = {};
  for (const [name, value] of Object.entries({
    CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_TUNNEL_ID: 'test-tunnel',
    NIXRE_RESERVED_DOMAINS: 'git.example.com', DEPLOY_BASE_DOMAIN: 'apps.example.com',
  })) { previous[name] = process.env[name]; process.env[name] = value; }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const domains = [];
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('FROM repos')) return { rows: [{ id: 7, space_uid: 'dev', uid: 'repo' }] };
      if (sql.includes('FROM deploy_services')) return { rows: [{ id: 1, repo_id: 7 }] };
      if (sql.includes('FROM space_members')) return { rows: [{ member: true }] };
      if (sql.includes('count(*)')) return { rows: [{ n: domains.length }] };
      if (sql.startsWith('SELECT 1 FROM deploy_domains')) return { rows: domains.filter(d => d.domain === params[0]) };
      if (sql.includes('INSERT INTO deploy_domains')) {
        const row = { id: domains.length + 1, service_id: params[0], kind: params[1], domain: params[2],
          tls_risk: params[3], verified: false, verify_token: params[4], created: params[5] };
        domains.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (sql.startsWith('UPDATE deploy_domains SET cf_zone_id')) {
        Object.assign(domains.find(d => d.id === params[2]), { cf_zone_id: params[0], cf_record_id: params[1], verified: true });
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE deploy_domains SET verified')) {
        domains.find(d => d.id === params[0]).verified = true;
        return { rows: [] };
      }
      if (sql.includes('FROM deploy_domains')) return { rows: sql.includes('WHERE id =')
        ? domains.filter(d => d.id === params[0] && d.service_id === params[1]) : domains };
      throw new Error(`Unhandled test query: ${sql}`);
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { user: { uid: 'dev', admin } }; next(); });
  app.use(deploymentRoutes(pool, () => (_req, _res, next) => next()));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  async function request(method, suffix = '', body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port,
        path: `/repos/dev/repo/+/deployments/services/1/domains${suffix}`, method,
        headers: { 'content-type': 'application/json' } }, res => {
        let text = '';
        res.on('data', d => { text += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { request, domains };
}

test('non-admin domain creation issues TXT, lists it, and never uses operator DNS credentials', async t => {
  const { request, domains } = await fixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected DNS automation'); });
  const created = await request('POST', '', { domain: 'login.example.com', kind: 'tunnel' });
  assert.equal(created.status, 201);
  assert.equal(created.body.verified, false);
  assert.equal(created.body.verification.method, 'txt');
  assert.equal(calls, 0);
  const listed = await request('GET');
  assert.equal(listed.status, 200);
  assert.equal(listed.body[0].verification.record.value, domains[0].verify_token);
  assert.equal((await request('POST', '/1/dns')).status, 403);
  assert.equal((await request('POST', '/1/verify', { force: true })).status, 403);
  assert.deepEqual(buildRoutes(domains, [], ''), []);
  t.mock.method(dns.Resolver.prototype, 'resolveTxt', async () => [[domains[0].verify_token]]);
  assert.equal((await request('POST', '/1/verify')).body.verified, true);
  assert.equal(buildRoutes(domains, [], '').length, 1);
  assert.equal(calls, 0);
});

test('admin DNS retry performs the same verification transition as initial provisioning', async t => {
  const { request, domains } = await fixture(t, { admin: true });
  let available = false;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    let result;
    if (String(url).includes('/zones?')) result = [{ id: 'zone', name: 'example.com' }];
    else if (!available) throw new Error('temporary provider failure');
    else if (init.method === 'POST') result = { id: 'new-record' };
    else result = [];
    return Response.json({ success: true, result });
  });
  const created = await request('POST', '', { domain: 'web.example.com', kind: 'tunnel' });
  assert.equal(created.status, 201);
  assert.equal(created.body.verified, false);
  available = true;
  const retried = await request('POST', '/1/dns');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.verified, true);
  assert.equal(domains[0].verified, true);
  assert.equal(buildRoutes(domains, [], '').length, 1);
  assert.equal((await request('GET')).body[0].verification.verified, true);
});

test('reserved domains cannot be force-approved or provisioned on retry', async t => {
  const { request, domains } = await fixture(t, { admin: true });
  domains.push({ id: 1, service_id: 1, domain: 'git.example.com', kind: 'tunnel', verified: false });
  assert.equal((await request('POST', '/1/verify', { force: true })).status, 409);
  assert.equal((await request('POST', '/1/dns')).status, 409);
  assert.equal((await request('POST', '', { domain: 'git.example.com' })).status, 409);
});

test('DNS automation refuses conflicting CNAMEs without a write', async t => {
  await fixture(t, { admin: true });
  const methods = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    methods.push(init.method || 'GET');
    return Response.json({ success: true, result: String(url).includes('/zones?')
      ? [{ id: 'zone', name: 'example.com' }]
      : [{ id: 'unrelated', content: 'identity.example.net', proxied: true }] });
  });
  await assert.rejects(createTunnelCname('login.example.com'), /refusing to overwrite/);
  assert.deepEqual(methods, ['GET', 'GET']);
});
