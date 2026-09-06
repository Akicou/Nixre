// Production IO bindings for the deployment engine — dockerode, git CLI, and
// HTTP probes. Deliberately thin: all behavior lives in deployments.js where
// these are replaced by fakes in tests.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { repoDir } from '../git/repo.js';
import { spawnedContainerNetwork } from './dockerNetwork.js';

const DOCKER_SOCKET = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') || '/var/run/docker.sock';

let docker = null;
let dockerAvailable = false;

// Same lazy-probe contract as agentSandbox: a failed early check never
// disables deployments for the process lifetime.
export async function getDocker() {
  if (dockerAvailable && docker) return docker;
  try {
    const { access, constants } = await import('node:fs/promises');
    await access(DOCKER_SOCKET, constants.R_OK | constants.W_OK);
    const mod = await import('dockerode');
    const Docker = mod.default || mod;
    docker = new Docker({ socketPath: DOCKER_SOCKET });
    await docker.ping();
    dockerAvailable = true;
  } catch {
    docker = null;
    dockerAvailable = false;
  }
  return docker;
}

function gitRun(bareDir, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', bareDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const onAbort = () => child.kill();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', err => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0 || (signal?.aborted && code !== null)) resolve(stdout);
      else reject(new Error(`git ${args[0]} failed (${code}): ${stderr.slice(0, 300)}`));
    });
  });
}

/**
 * Reject a git ref that could be parsed as an option instead of a revision.
 *
 * `git` is invoked with an argument array, so there is no shell injection —
 * but a ref beginning with `-` is still read as a flag (`--upload-pack=…`,
 * `--output=…`), which turns a user-supplied ref into option injection. Refs
 * reach here from API query strings and deploy service config.
 */
export function assertSafeRef(ref, label = 'ref') {
  const value = String(ref ?? '').trim();
  if (!value) throw new Error(`${label} is required`);
  if (value.startsWith('-')) {
    throw new Error(`${label} may not start with '-' (${value.slice(0, 40)})`);
  }
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} may not contain control characters`);
  }
  if (value.length > 400) throw new Error(`${label} is too long`);
  return value;
}

export async function resolveRef(space, repo, ref) {
  const dir = repoDir(space, repo);
  const safe = assertSafeRef(ref);
  const sha = (await gitRun(dir, ['rev-parse', '--verify', `${safe}^{commit}`])).trim();
  let message = '';
  try {
    message = (
      await gitRun(dir, [
        'log',
        '-1',
        '--format=%s',
        '--no-show-signature',
        sha,
      ])
    ).trim();
  } catch {
    /* subject is best-effort */
  }
  return { sha, message };
}

export async function archiveTar(space, repo, spec, signal) {
  const dir = repoDir(space, repo);
  return gitStream(dir, ['archive', '--format=tar', spec], signal);
}

function gitStream(bareDir, args, signal) {
  const child = spawn('git', ['-C', bareDir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => (stderr += d));
  const fail = () =>
    Object.assign(new Error(`git ${args[0]} failed: ${stderr.slice(0, 200)}`), { fatal: true });
  child.on('error', () => child.kill());
  const maybeFail = new Promise((_, reject) => {
    child.on('close', code => {
      if (code !== 0) reject(fail());
    });
  });
  // Rejected upstream errors propagate; success hands off the stdout stream.
  child.stdout.on('error', () => child.kill());
  void maybeFail.catch(err => child.stdout.destroy(err));
  const onAbort = () => {
    try {
      child.stdout.destroy(new Error('Build cancelled'));
    } catch {
      /* already gone */
    }
    child.kill();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return child.stdout;
}

export async function listTree(space, repo, ref) {
  const dir = repoDir(space, repo);
  const safe = assertSafeRef(ref);
  // `--` ends option parsing so a ref is always treated as a revision.
  const out = await gitRun(dir, ['ls-tree', '-r', '--name-only', '--', safe]);
  return out.split('\n').filter(Boolean).map(l => l.replace(/^"|"$/g, ''));
}

// A release is only healthy when the app answers with a non-error status.
//
// This used to treat ANY HTTP response as healthy (`ok: Boolean(statusCode)`),
// so an app returning 500 or 503 on first request passed its health check and
// was promoted over the container already serving traffic — a blue/green swap
// that replaced a working release with a broken one. 2xx and 3xx pass (a
// redirect is a listening, configured app); 4xx is tolerated so apps that
// require auth on `/` still release; 5xx is a failure.
export function probeHttp() {
  return ({ host, port, path, timeoutMs, signal } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.get(
        { host, port, path: path || '/', timeout: timeoutMs || 2500, signal },
        res => {
          res.resume();
          const status = res.statusCode ?? null;
          const ok = status != null && status < 500;
          resolve({ ok, status });
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`probe timed out after ${timeoutMs}ms`));
      });
      req.on('error', reject);
    });
}

// Network for deployed app containers. Must be a network core is on (core
// probes the container and proxies to it by IP) and must NEVER be the database
// network — a deployment's Dockerfile is user-supplied code, and creating one
// only needs write access to a space.
//
// Deliberately not cached across calls: the operator can change
// NIXRE_APPS_NETWORK and core picks it up on the next release.
export async function networkName(docker) {
  return spawnedContainerNetwork(docker, {
    preferred: process.env.NIXRE_APPS_NETWORK,
    role: 'app',
  });
}
