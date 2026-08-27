// Central deploy proxy — one HTTP listener that routes public traffic to
// deployed app containers living on core's docker network, and records every
// request into deploy_http_logs (the preserve-failed-requests data source).
//
// Routing order per Host header:
//   1. exact custom domain rows (deploy_domains)
//   2. vanity `<service.name>.<DEPLOY_BASE_DOMAIN>` when the name is unique
//      among currently serving services
//   3. deterministic `svc-<id>.<DEPLOY_BASE_DOMAIN>`
// Unmatched hosts get a plain "nothing routed" page, never panel traffic.
//
// HTTP request logging happens here because this is the only hop every
// response crosses regardless of how the user fronts it (host Caddy,
// Cloudflare Tunnel, direct port).

import http from 'node:http';
import { resolveRoute } from './deployPure.js';

const LOG_FLUSH_MS = 2000;
const LOG_BUFFER_CAP = 10_000;
const ROUTE_CACHE_MS = 5000;

// Pure: builds the routing table consumed by resolveRoute from DB rows.
export function buildRoutes(domainRows, serviceRows, baseDomain) {
  const routes = [];
  for (const row of domainRows || []) {
    // Custom domains stay routable even while a service is stopped so the
    // user gets an explicit "not accepting traffic" page instead of 404.
    routes.push({ host: String(row.domain).toLowerCase(), serviceId: row.service_id });
  }
  const base = String(baseDomain || '').toLowerCase().replace(/\.$/, '');
  if (base) {
    const nameCounts = new Map();
    for (const svc of serviceRows || []) {
      nameCounts.set(svc.name, (nameCounts.get(svc.name) || 0) + 1);
    }
    for (const svc of serviceRows || []) {
      // Vanity form only when unambiguous among serving services…
      if (nameCounts.get(svc.name) === 1) {
        routes.push({ host: `${String(svc.name).toLowerCase()}.${base}`, serviceId: svc.id });
      }
      // …and the deterministic id form always exists.
      routes.push({ host: `svc-${svc.id}.${base}`, serviceId: svc.id });
    }
  }
  return routes;
}

export function createDeployProxy({ pool, engine }) {
  const logBuffer = [];
  const stats = { flushed: 0, dropped: 0 };
  let flushTimer = null;

  const baseDomain = process.env.DEPLOY_BASE_DOMAIN || '';

  let cachedAt = 0;
  let cachedRoutes = [];

  async function refreshRoutes(force = false) {
    const nowMs = Date.now();
    if (!force && nowMs - cachedAt < ROUTE_CACHE_MS) return cachedRoutes;
    try {
      const [{ rows: domains }, { rows: services }] = await Promise.all([
        pool.query(
          `SELECT d.domain, d.service_id FROM deploy_domains d
           JOIN deploy_services s ON s.id = d.service_id`,
        ),
        pool.query(
          `SELECT id, name FROM deploy_services
           WHERE desired_state = 'running' AND current_deployment_id IS NOT NULL`,
        ),
      ]);
      cachedRoutes = buildRoutes(domains, services, baseDomain);
      cachedAt = nowMs;
    } catch (err) {
      console.error('deploy proxy route refresh failed:', err.message);
      cachedRoutes = [];
      cachedAt = nowMs;
    }
    return cachedRoutes;
  }

  async function flushLogs() {
    if (!logBuffer.length) return;
    const batch = logBuffer.splice(0, logBuffer.length);
    const values = [];
    const params = [];
    batch.forEach((row, i) => {
      const o = i * 6;
      values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`);
      params.push(
        row.service_id,
        row.method.slice(0, 16),
        String(row.path || '').slice(0, 500),
        row.status_code ?? null,
        row.duration_ms ?? null,
        row.ts,
      );
    });
    try {
      await pool.query(
        `INSERT INTO deploy_http_logs (service_id, method, path, status_code, duration_ms, ts)
         VALUES ${values.join(',')}`,
        params,
      );
      stats.flushed += batch.length;
    } catch (err) {
      stats.dropped += batch.length;
      console.error('deploy proxy http-log flush failed:', err.message);
    }
  }

  function recordLog(service_id, req, statusCode, t0) {
    if (logBuffer.length >= LOG_BUFFER_CAP) {
      logBuffer.shift();
      stats.dropped++;
    }
    logBuffer.push({
      service_id,
      method: req.method,
      path: req.url,
      status_code: statusCode ?? null,
      duration_ms: Date.now() - t0,
      ts: Date.now(),
    });
  }

  function page(res, code, title, detailHtml) {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(code, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
        `<body style="font-family:system-ui;background:#0f1115;color:#e7e9ee;display:grid;place-items:center;height:95vh;margin:0">` +
        `<div style="text-align:center"><div style="font-size:15px;color:#9aa1ac">${title}</div>` +
        `<div style="margin-top:8px;font-size:13px;color:#6b7280">${detailHtml}</div></div></body>`,
    );
  }

  async function routeHost(hostHeader) {
    const routes = await refreshRoutes();
    const host = String(hostHeader || '').trim().toLowerCase().replace(/:\d+$/, '');
    const serviceId = resolveRoute(host, routes);
    if (serviceId == null) return { matched: false, serviceId: null, target: null };
    const target = await engine.findServiceTarget(serviceId);
    return { matched: true, serviceId, target };
  }

  async function handle(req, res) {
    const t0 = Date.now();

    if (req.url === '/_nixre_healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, proxy: true }));
      return;
    }

    const routed = await routeHost(req.headers.host).catch(err => {
      console.error('deploy proxy routing error:', err.message);
      return { matched: false, serviceId: null, target: null };
    });

    if (!routed.matched) {
      page(
        res,
        404,
        'No Nixre deployment for this address',
        baseDomain
          ? `Attach the domain to your service in Nixre, or use <code>svc-&lt;id&gt;.${baseDomain}</code>.`
          : 'Attach a custom domain to your service, or set DEPLOY_BASE_DOMAIN for automatic addresses.',
      );
      return;
    }

    if (!routed.target) {
      page(
        res,
        503,
        'This app is not accepting traffic right now',
        'It may be starting up, stopped, or its latest release failed.',
      );
      recordLog(routed.serviceId, req, 503, t0);
      return;
    }

    await pipeToContainer(req, res, routed).catch(() => {});
    recordLog(routed.serviceId, req, res.statusCode ?? null, t0);
  }

  function pipeToContainer(req, res, routed) {
    const { target } = routed;
    return new Promise(resolve => {
      const originalHost = req.headers.host || '';
      const headers = { ...req.headers };
      delete headers.connection;
      headers['x-forwarded-for'] = `${req.headers['x-forwarded-for'] || ''} ${
        req.socket.remoteAddress || ''
      }`.trim();
      headers['x-forwarded-proto'] =
        req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
      headers['x-forwarded-host'] = originalHost;
      headers.host = originalHost;

      const upstream = http.request({
        host: target.ip,
        port: target.port,
        path: req.url,
        method: req.method,
        headers,
      });
      upstream.setTimeout(120_000, () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('error', () => {
        page(res, 502, 'Upstream error', 'The app container dropped the connection.');
        resolve();
      });
      const up = upstream.endWithBody ?? null;
      void up;
      upstream.on('response', ures => {
        res.writeHead(ures.statusCode || 502, ures.headers);
        ures.pipe(res);
        ures.on('end', () => resolve());
        ures.on('error', () => {
          res.destroy();
          resolve();
        });
      });
      req.on('error', () => {
        upstream.destroy();
        resolve();
      });
      req.pipe(upstream);
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error('deploy proxy handler crashed:', err.message);
      page(res, 500, 'Proxy error', '');
    });
  });

  // Best-effort WebSocket pass-through for apps that need it.
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const routed = await routeHost(req.headers.host).catch(() => ({ target: null }));
      if (!routed.target) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const { default: net } = await import('node:net');
      const upstream = net.connect(routed.target.port, routed.target.ip, () => {
        const lines = [
          `${req.method} ${req.url} HTTP/1.1`,
          ...Object.entries(req.headers)
            .filter(([k]) => k !== 'connection')
            .map(([k, v]) => `${k}: ${v}`),
          `x-forwarded-for: ${req.socket.remoteAddress || ''}`,
          'connection: Upgrade',
          '',
        ];
        upstream.write(lines.join('\r\n') + '\r\n');
        if (head?.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
      });
    })().catch(() => socket.destroy());
  });

  async function listen(port = Number(process.env.DEPLOY_PROXY_PORT || 3003), bindAddress) {
    flushTimer = setInterval(() => void flushLogs(), LOG_FLUSH_MS);
    flushTimer.unref();
    return new Promise(resolve => server.listen(port, bindAddress, () => resolve(server.address())));
  }

  async function stop() {
    if (flushTimer) clearInterval(flushTimer);
    await flushLogs();
    await new Promise(resolve => server.close(resolve));
  }

  return {
    server,
    listen,
    stop,
    handle,
    routeHost,
    refreshRoutes: () => refreshRoutes(true),
    invalidateRoutes: () => (cachedAt = 0),
    stats: () => ({ ...stats, pending: logBuffer.length }),
  };
}
