// Security scanner building blocks: the read-only exec allowlist, inventory
// parsers, CVE lookups (OSV + the Node.js release index) and finding hashing.
// No database or model code lives here, so everything is unit-testable.

import crypto from 'node:crypto';
import { guardedFetch } from './netGuard.js';

// --- safe exec ---------------------------------------------------------------
// Commands run through the Docker API as an argv array, never through a shell,
// and only if they match this list exactly. Each one only prints versions or
// package lists. Anything else — including a model's creative variation — is
// refused before it reaches the container.
const SAFE_ARGV = [
  ['node', '-v'],
  ['npm', 'ls', '--all', '--json'],
  ['python', '--version'],
  ['python3', '--version'],
  ['pip', 'list', '--format=json'],
  ['pip3', 'list', '--format=json'],
  ['cat', '/etc/os-release'],
  ['apk', 'info', '-v'],
  ['dpkg-query', '-W', '-f=${source:Package}\t${Version}\n'],
  ['java', '-version'],
  ['go', 'version'],
  ['uname', '-m'],
].map(a => JSON.stringify(a));

export function isSafeCommand(argv) {
  return Array.isArray(argv) && argv.every(a => typeof a === 'string') && SAFE_ARGV.includes(JSON.stringify(argv));
}

export const SAFE_COMMAND_LIST = SAFE_ARGV.map(a => JSON.parse(a));

const EXEC_TIMEOUT_MS = 20_000;
const EXEC_MAX_BYTES = 512 * 1024;

/** Run an allowlisted argv in a container. Resolves {ok, output}; never throws for in-container failures. */
export async function execSafe(docker, containerName, argv) {
  if (!isSafeCommand(argv)) throw new Error(`Command not allowed. Allowed: ${SAFE_COMMAND_LIST.map(a => a.join(' ')).join(' | ')}`);
  const container = docker.getContainer(containerName);
  const exec = await container.exec({ Cmd: argv, AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks = [];
  let bytes = 0;
  const sink = { write(chunk) { if (bytes < EXEC_MAX_BYTES) { chunks.push(chunk); bytes += chunk.length; } } };
  docker.modem.demuxStream(stream, sink, sink);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stream.destroy(); reject(new Error('exec timed out')); }, EXEC_TIMEOUT_MS);
    stream.on('end', () => { clearTimeout(timer); resolve(); });
    stream.on('error', err => { clearTimeout(timer); reject(err); });
  });
  const info = await exec.inspect().catch(() => ({ ExitCode: 0 }));
  return { ok: info.ExitCode === 0, output: Buffer.concat(chunks).toString('utf8').slice(0, EXEC_MAX_BYTES) };
}

// --- inventory parsers -> OSV queries ------------------------------------------

export function parseNpmTree(json) {
  const seen = new Map();
  (function walk(deps) {
    for (const [name, d] of Object.entries(deps ?? {})) {
      if (d?.version) seen.set(`${name}@${d.version}`, { name, version: d.version });
      walk(d?.dependencies);
    }
  })(json?.dependencies);
  return [...seen.values()].map(p => ({ ...p, ecosystem: 'npm' }));
}

export function parsePipList(json) {
  return (Array.isArray(json) ? json : [])
    .filter(p => p?.name && p?.version)
    .map(p => ({ name: p.name, version: p.version, ecosystem: 'PyPI' }));
}

export function parseOsRelease(text) {
  const kv = Object.fromEntries(
    String(text).split('\n').map(l => l.match(/^(\w+)=("?)(.*)\2$/)).filter(Boolean).map(m => [m[1], m[3]]),
  );
  return { id: kv.ID ?? '', versionId: kv.VERSION_ID ?? '', pretty: kv.PRETTY_NAME ?? '' };
}

// OSV's distro ecosystems are versioned; return null when we can't name one.
export function osvDistroEcosystem(os) {
  if (os.id === 'alpine') return `Alpine:v${os.versionId.split('.').slice(0, 2).join('.')}`;
  if (os.id === 'debian') return `Debian:${os.versionId.split('.')[0]}`;
  return null;
}

export function parseApkInfo(text, ecosystem) {
  return String(text).split('\n').map(l => l.trim().match(/^(.+)-(\d[^-]*-r\d+)$/)).filter(Boolean)
    .map(m => ({ name: m[1], version: m[2], ecosystem }));
}

export function parseDpkg(text, ecosystem) {
  const seen = new Map();
  for (const line of String(text).split('\n')) {
    const [name, version] = line.split('\t');
    if (name && version) seen.set(`${name}@${version}`, { name, version, ecosystem });
  }
  return [...seen.values()];
}

// --- CVE sources ---------------------------------------------------------------

const OSV = 'https://api.osv.dev/v1';

async function osvFetch(path, init) {
  const r = await guardedFetch(`${OSV}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json' },
  }, { timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`OSV returned HTTP ${r.status}`);
  return r.json();
}

/** Look up vulnerabilities for packages. Returns [{pkg, ids[]}] for packages that have any. */
export async function osvQuery(packages) {
  const hits = [];
  for (let i = 0; i < packages.length; i += 500) {
    const slice = packages.slice(i, i + 500);
    const { results } = await osvFetch('/querybatch', {
      method: 'POST',
      body: JSON.stringify({
        queries: slice.map(p => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })),
      }),
    });
    (results ?? []).forEach((res, j) => {
      const ids = (res?.vulns ?? []).map(v => v.id);
      if (ids.length) hits.push({ pkg: slice[j], ids });
    });
  }
  return hits;
}

export function summarizeOsvVuln(v) {
  const sev = (v.database_specific?.severity ?? '').toString().toUpperCase();
  const fixed = [];
  for (const a of v.affected ?? []) {
    for (const range of a.ranges ?? []) {
      for (const ev of range.events ?? []) if (ev.fixed) fixed.push(ev.fixed);
    }
  }
  return {
    id: v.id,
    aliases: (v.aliases ?? []).filter(a => a.startsWith('CVE-')).slice(0, 3),
    summary: String(v.summary ?? v.details ?? '').slice(0, 240),
    severity: sev || 'UNKNOWN',
    fixed: [...new Set(fixed)].slice(0, 4),
  };
}

export async function osvDetails(id) {
  return summarizeOsvVuln(await osvFetch(`/vulns/${encodeURIComponent(id)}`, { method: 'GET' }));
}

const semver = v => String(v).replace(/^v/, '').split('.').map(n => Number(n) || 0);
const cmp = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/**
 * Node.js core isn't in OSV, but nodejs.org flags security releases. Behind =
 * a newer release on the same major line is marked `security`.
 * @param {string} running e.g. "v22.23.2"
 * @param {{version:string,security:boolean,date:string}[]} index nodejs.org/dist/index.json
 */
export function nodeSecurityLag(running, index) {
  const major = semver(running)[0];
  const newer = index.filter(e => semver(e.version)[0] === major && cmp(e.version, running) > 0);
  const secFixes = newer.filter(e => e.security);
  if (!secFixes.length) return null;
  const latest = newer.reduce((a, b) => (cmp(a.version, b.version) >= 0 ? a : b));
  return {
    running,
    latest: latest.version,
    securityReleasesBehind: secFixes.length,
    newestSecurityRelease: secFixes.reduce((a, b) => (cmp(a.version, b.version) >= 0 ? a : b)).version,
  };
}

export async function fetchNodeIndex() {
  const r = await guardedFetch('https://nodejs.org/dist/index.json', {}, { timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`nodejs.org returned HTTP ${r.status}`);
  return r.json();
}

// --- hashing -------------------------------------------------------------------

/** Stable hash of "what is vulnerable where". Unchanged hash => nothing new to triage. */
export function fingerprintFindings(findings) {
  const lines = findings
    .map(f => `${f.target}|${f.kind}|${f.package ?? ''}|${f.version ?? ''}|${(f.ids ?? []).slice().sort().join(',')}`)
    .sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Issue dedupe key: one issue per (repo, key) so each scan finds its own work again. */
export function issueFingerprint(repo, key) {
  return crypto.createHash('sha256').update(`${repo}\n${key}`).digest('hex').slice(0, 32);
}
