// Pure helpers for the deployments feature — path detection, proxy routing,
// resource math, naming, and uptime bucketing. Everything here must stay free
// of DB / Docker / network dependencies so it is trivially unit-testable.

import crypto from 'node:crypto';

// Repo-relative root dir for a service. '' | '/' -> '.'; rejects escapes so a
// crafted root_dir can never reach outside the archived tree.
export function normalizeRootDir(dir) {
  const cleaned = String(dir ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(seg => seg !== '' && seg !== '.')
    .join('/');
  if (cleaned === '') return '.';
  const segments = [];
  for (const seg of cleaned.split('/')) {
    if (seg === '..') throw new Error('root_dir may not traverse upwards');
    segments.push(seg);
  }
  return segments.join('/') || '.';
}

const DOCKERFILE_RE = /(?:^|\/)dockerfile(?:\.[^/]+)?$/i;

// From `git ls-tree -r --name-only` output: every Dockerfile inside rootDir.
// Returns [{path: repoRelative, file: contextRelative}] sorted by path.
export function filterDockerfiles(paths, rootDir) {
  const root = normalizeRootDir(rootDir);
  const prefix = root === '.' ? '' : `${root}/`;
  const found = [];
  for (const p of paths) {
    if (!prefix) {
      if (!DOCKERFILE_RE.test(p)) continue;
      found.push({ path: p, file: p });
      continue;
    }
    if (!p.startsWith(prefix)) continue;
    if (!DOCKERFILE_RE.test(p)) continue;
    found.push({ path: p, file: p.slice(prefix.length) });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

// `git archive` revspec whose tarball has the Dockerfile at its root.
export function archiveSpec(revision, rootDir) {
  const root = normalizeRootDir(rootDir);
  const rev = String(revision || 'HEAD');
  return root === '.' ? rev : `${rev}:${root}`;
}

function splitHost(hostHeader) {
  return String(hostHeader || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
}

// Host-based virtual routing for the central deploy proxy. Exact custom
// domains win; `name.<baseDomain>` fleet names are matched implicitly.
export function subdomainHost(serviceName, baseDomain) {
  return `${String(serviceName).toLowerCase()}.${String(baseDomain).toLowerCase()}`;
}

export function resolveRoute(hostHeader, routes) {
  const host = splitHost(hostHeader);
  if (!host) return null;
  for (const r of routes || []) {
    if (r && splitHost(r.host) === host) return r.serviceId ?? null;
  }
  return null;
}

// Container stats sample -> usage relative to the service's configured caps.
// Docker reports cpu/system deltas in ns over one stats window:
//   cores_used = deltaCpu/deltaSystem * online_cpus
//   pctOfLimit = cores_used / limitCores * 100   (may exceed 100 briefly)
export function computeUsage(stats, limits) {
  const safe = stats || {};
  const memStats = safe.memory_stats || {};
  const cur = safe.cpu_stats || {};
  const prev = safe.precpu_stats || {};
  const curTotal = cur?.cpu_usage?.total_usage ?? 0;
  const prevTotal = prev?.cpu_usage?.total_usage ?? 0;
  const curSystem = cur.system_cpu_usage ?? 0;
  const prevSystem = prev.system_cpu_usage ?? 0;
  const online = Math.max(1, Number(cur.online_cpus || 1));

  let cpuPctOfLimit = 0;
  const dCpu = curTotal - prevTotal;
  const dSys = curSystem - prevSystem;
  if (dCpu > 0 && dSys > 0) {
    const coresUsed = (dCpu / dSys) * online;
    const limitCores = Math.max(1e-9, Number(limits.cpuNanoCpus || 0) / 1e9);
    cpuPctOfLimit = (coresUsed / limitCores) * 100;
  }

  // Docker counts page cache in memory_stats.usage — subtract what it exposes
  // as cache/inactive_file so the bar shows real working set.
  const cache =
    Number(memStats.stats?.cache || 0) +
    Number(memStats.stats?.inactive_file || 0);
  const memUsedBytes = Math.max(0, Number(memStats.usage || 0) - cache);
  const memLimit = Math.max(1, Number(limits.memoryBytes || 0));
  const memPctOfLimit = memLimit ? (memUsedBytes / memLimit) * 100 : 0;

  return { cpuPctOfLimit, memUsedBytes, memPctOfLimit };
}

export function makeImageTag(serviceId, deploymentId) {
  return `nixre-app-svc${Number(serviceId)}-dep${Number(deploymentId)}:nixre`;
}

// Blue/green overlap means two containers per service can coexist briefly, so
// the name covers both ids. Deterministic so proxy/sweeper can find it again.
export function containerName(serviceId, deploymentId) {
  const hash = crypto
    .createHash('sha256')
    .update(`nixre-app-svc:${serviceId}:dep:${deploymentId}`)
    .digest('hex')
    .slice(0, 10);
  return `nixre-app-${hash}`;
}

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '';
}

// Fold probe rows into fixed-width buckets: up | down | empty windows.
export function bucketizeUptime(checks, rangeStartMs, rangeEndMs, bucketMs) {
  const out = [];
  if (!(rangeEndMs > rangeStartMs) || !(bucketMs > 0)) return out;
  const buckets = Math.ceil((rangeEndMs - rangeStartMs) / bucketMs);
  for (let i = 0; i < buckets; i++) out.push({ start: rangeStartMs + i * bucketMs, state: 'empty' });
  for (const c of checks || []) {
    if (c.ts < rangeStartMs || c.ts >= rangeEndMs) continue;
    const idx = Math.min(out.length - 1, Math.floor((c.ts - rangeStartMs) / bucketMs));
    if (out[idx].state === 'empty') out[idx].state = c.ok ? 'up' : 'down';
    else if (!c.ok) out[idx].state = 'down'; // any failure reddens the bucket
  }
  return out;
}

export function statusClass(code) {
  if (code == null) return 'none';
  if (code >= 200 && code < 300) return '2xx';
  if (code >= 300 && code < 400) return '3xx';
  if (code >= 400 && code < 500) return '4xx';
  if (code >= 500 && code < 600) return '5xx';
  return 'none';
}

// Service name doubles as a DNS label — keep it slug-safe.
export function sanitizeServiceName(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'app';
}
