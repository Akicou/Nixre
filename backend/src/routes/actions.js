// Nixre Actions API (CI/CD runs, secrets, badges), commit statuses, PR checks,
// stars, archive downloads and the file list behind the "t" file finder.
//
// Reads use optional auth so public repositories work for guests, exactly
// like the rest of the repo API; every read goes through loadReadableRepo.

import express from 'express';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { encryptSecret } from '../lib/ai.js';
import { canWriteRepo, loadReadableRepo } from '../lib/repoAccess.js';
import { combinedState } from '../lib/commitStatus.js';
import { repoDir } from '../git/repo.js';
import { assertSafeRef, resolveRef } from '../lib/deployDrivers.js';

const exec = promisify(execFile);
const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_SECRETS = 100;
const MAX_FILES = 50_000;
const STATUS_STATES = new Set(['pending', 'success', 'failure', 'error']);

function runPayload(r) {
  return {
    id: Number(r.id),
    number: Number(r.run_number),
    workflow_path: r.workflow_path,
    workflow_name: r.workflow_name,
    event: r.event,
    ref: r.ref,
    branch: r.ref.startsWith('refs/heads/') ? r.ref.slice(11) : null,
    tag: r.ref.startsWith('refs/tags/') ? r.ref.slice(10) : null,
    sha: r.sha,
    pr_number: r.pr_number == null ? null : Number(r.pr_number),
    actor: r.actor,
    inputs: r.inputs || {},
    status: r.status,
    conclusion: r.conclusion,
    error: r.error || null,
    created: Number(r.created),
    started: r.started == null ? null : Number(r.started),
    finished: r.finished == null ? null : Number(r.finished),
  };
}

function jobPayload(j) {
  return {
    id: Number(j.id),
    key: j.job_key,
    name: j.name,
    matrix: j.matrix || {},
    needs: j.needs || [],
    image: j.image || '',
    status: j.status,
    conclusion: j.conclusion,
    steps: j.steps || [],
    started: j.started == null ? null : Number(j.started),
    finished: j.finished == null ? null : Number(j.finished),
  };
}

function statusPayload(s) {
  return {
    context: s.context,
    state: s.state,
    description: s.description,
    target_url: s.target_url,
    created: Number(s.created),
    updated: Number(s.updated),
  };
}

// --- badge ---------------------------------------------------------------------------

const escapeXml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
// Rough Verdana 11px advance widths; good enough for a flat badge.
const textWidth = s => [...String(s)].reduce((w, c) => w + (/[ilj.,:;|!']/.test(c) ? 3.5 : /[mwMW]/.test(c) ? 10 : /[A-Z0-9]/.test(c) ? 7.5 : 6.5), 0);

export function badgeSvg(label, message, color) {
  const lw = Math.round(textWidth(label) + 12);
  const mw = Math.round(textWidth(message) + 12);
  const w = lw + mw;
  const l = escapeXml(label);
  const m = escapeXml(message);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${l}: ${m}"><title>${l}: ${m}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${l}</text><text x="${lw / 2}" y="14">${l}</text><text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3">${m}</text><text x="${lw + mw / 2}" y="14">${m}</text></g></svg>`;
}

const BADGE = {
  success: ['passing', '#2ea043'],
  failure: ['failing', '#d1242f'],
  cancelled: ['cancelled', '#6e7781'],
  skipped: ['skipped', '#6e7781'],
  none: ['no runs', '#9e9e9e'],
};

// --- routes ------------------------------------------------------------------------------

/**
 * @param {import('pg').Pool} pool
 * @param {Function} authenticate
 * @param {{ engine?: object, store?: object }} [deps]  injected in tests;
 *   production loads the shared runtime lazily.
 */
export function actionsRoutes(pool, authenticate, deps = {}) {
  const api = express.Router();
  const auth = authenticate(true);
  const optionalAuth = authenticate(false);
  let runtime = deps.engine && deps.store ? deps : null;
  const getRuntime = async () => {
    if (!runtime) {
      const mod = await import('../lib/actionsRuntime.js');
      runtime = { engine: mod.actionsEngine, store: mod.actionsStore };
    }
    return runtime;
  };
  const viewer = req => req.auth?.user ?? null;
  const guard = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  async function readable(req, res) {
    const { repo, error } = await loadReadableRepo(pool, req.params.space, req.params.repo, viewer(req));
    if (error) {
      res.status(error.status).json({ message: error.message });
      return null;
    }
    return repo;
  }
  async function writable(req, res) {
    const repo = await readable(req, res);
    if (!repo) return null;
    if (!(await canWriteRepo(pool, repo, viewer(req)))) {
      res.status(403).json({ message: 'No write access' });
      return null;
    }
    return repo;
  }
  async function loadRun(req, res, repo) {
    const { store } = await getRuntime();
    const run = await store.getRunByNumber(repo.id, Number(req.params.number));
    if (!run) {
      res.status(404).json({ message: 'Run not found' });
      return null;
    }
    return run;
  }

  const R = '/repos/:space/:repo/\\+';

  // --- workflows & runs ---------------------------------------------------------------

  api.get(`${R}/actions/workflows`, optionalAuth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    const { engine } = await getRuntime();
    const ref = String(req.query.ref || repo.default_branch);
    let sha;
    try {
      ({ sha } = await resolveRef(repo.space_uid, repo.uid, ref));
    } catch {
      res.json({ ref, workflows: [] });
      return;
    }
    const found = await engine.discover(repo.space_uid, repo.uid, sha);
    res.json({
      ref,
      sha,
      workflows: found.map(e => ({
        path: e.path,
        name: e.workflow?.name ?? e.path.split('/').pop(),
        error: e.error || null,
        events: e.workflow ? Object.keys(e.workflow.on) : [],
        schedule: e.workflow?.on.schedule || [],
        inputs: e.workflow?.on.workflow_dispatch?.inputs || null,
        jobs: e.workflow ? e.workflow.jobs.map(j => ({ id: j.id, name: j.name })) : [],
      })),
    });
  }));

  api.get(`${R}/actions/runs`, optionalAuth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    const { store } = await getRuntime();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const page = Math.max(1, Number(req.query.page) || 1);
    const runs = await store.listRuns(repo.id, {
      workflow: req.query.workflow ? String(req.query.workflow) : undefined,
      branch: req.query.branch ? String(req.query.branch) : undefined,
      event: req.query.event ? String(req.query.event) : undefined,
      limit,
      offset: (page - 1) * limit,
    });
    res.json({ runs: runs.map(runPayload), page, limit });
  }));

  api.get(`${R}/actions/runs/:number`, optionalAuth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    const run = await loadRun(req, res, repo);
    if (!run) return;
    const { store } = await getRuntime();
    const jobs = await store.listJobs(run.id);
    res.json({
      run: runPayload(run),
      jobs: jobs.map(jobPayload),
      can_write: await canWriteRepo(pool, repo, viewer(req)),
    });
  }));

  api.get(`${R}/actions/runs/:number/jobs/:jobId/log`, optionalAuth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    const run = await loadRun(req, res, repo);
    if (!run) return;
    const { store } = await getRuntime();
    const job = await store.getJob(Number(req.params.jobId));
    if (!job || Number(job.run_id) !== Number(run.id)) {
      res.status(404).json({ message: 'Job not found' });
      return;
    }
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(job.log || '');
  }));

  api.get(`${R}/actions/runs/:number/events`, optionalAuth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    const run = await loadRun(req, res, repo);
    if (!run) return;
    const { engine } = await getRuntime();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = evt => res.write(`data: ${JSON.stringify(evt)}\n\n`);
    send({ type: 'hello', runId: Number(run.id) });
    const unsubscribe = engine.subscribe(Number(run.id), send);
    // A run this process is not executing (finished, or from before a
    // restart) will produce no more events.
    if (!engine.isActive(run.id)) send({ type: 'end' });
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        /* closed */
      }
    }, 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }));

  api.post(`${R}/actions/runs/:number/cancel`, auth, guard(async (req, res) => {
    const repo = await writable(req, res);
    if (!repo) return;
    const run = await loadRun(req, res, repo);
    if (!run) return;
    const { engine } = await getRuntime();
    const cancelled = await engine.cancel(run.id);
    if (!cancelled) {
      res.status(409).json({ message: 'This run is not in progress' });
      return;
    }
    res.json({ ok: true });
  }));

  api.post(`${R}/actions/runs/:number/rerun`, auth, guard(async (req, res) => {
    const repo = await writable(req, res);
    if (!repo) return;
    const run = await loadRun(req, res, repo);
    if (!run) return;
    const { engine } = await getRuntime();
    try {
      const next = await engine.rerun(run, viewer(req).uid);
      res.status(201).json(runPayload(next));
    } catch (err) {
      res.status(err.status || 500).json({ message: err.message });
    }
  }));

  api.post(`${R}/actions/dispatch`, auth, guard(async (req, res) => {
    const repo = await writable(req, res);
    if (!repo) return;
    const workflow = String(req.body?.workflow || '');
    const ref = req.body?.ref ? String(req.body.ref) : undefined;
    if (!workflow) {
      res.status(400).json({ message: 'workflow is required' });
      return;
    }
    try {
      if (ref) assertSafeRef(ref);
      const inputs = req.body?.inputs && typeof req.body.inputs === 'object' ? req.body.inputs : {};
      const { engine } = await getRuntime();
      const run = await engine.dispatch({ repoRow: repo, workflowPath: workflow, ref, inputs, actor: viewer(req).uid });
      res.status(201).json(runPayload(run));
    } catch (err) {
      res.status(err.status || 400).json({ message: err.message });
    }
  }));

  // Status badge: ![CI](/api/v1/repos/acme/web/+/actions/badge.svg?workflow=ci.yml&branch=main)
  api.get(`${R}/actions/badge.svg`, optionalAuth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    const { store } = await getRuntime();
    const workflow = req.query.workflow ? String(req.query.workflow) : undefined;
    const branch = String(req.query.branch || repo.default_branch);
    const run = await store.latestCompletedRun(repo.id, { workflow, branch });
    const [message, color] = BADGE[run?.conclusion || 'none'] || BADGE.none;
    const label = String(req.query.label || run?.workflow_name || workflow || 'build').slice(0, 40);
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', 'no-cache, max-age=0');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(badgeSvg(label, message, color));
  }));

  // --- secrets ---------------------------------------------------------------------------

  api.get(`${R}/actions/secrets`, auth, guard(async (req, res) => {
    const repo = await writable(req, res);
    if (!repo) return;
    const { rows } = await pool.query('SELECT key, updated FROM repo_secrets WHERE repo_id = $1 ORDER BY key', [repo.id]);
    res.json(rows.map(r => ({ key: r.key, updated: Number(r.updated) })));
  }));

  api.put(`${R}/actions/secrets/:key`, auth, guard(async (req, res) => {
    const repo = await writable(req, res);
    if (!repo) return;
    const key = String(req.params.key);
    const value = req.body?.value;
    if (!SECRET_KEY_RE.test(key) || /^(GITHUB|GITEA|NIXRE)_/i.test(key)) {
      res.status(400).json({ message: 'Secret names use letters, digits and _, and may not start with GITHUB_, GITEA_ or NIXRE_' });
      return;
    }
    if (typeof value !== 'string' || value === '' || Buffer.byteLength(value) > MAX_SECRET_BYTES) {
      res.status(400).json({ message: 'value must be a non-empty string up to 64 KB' });
      return;
    }
    const { rows: count } = await pool.query(
      'SELECT count(*)::int AS n FROM repo_secrets WHERE repo_id = $1 AND key <> $2',
      [repo.id, key],
    );
    if (count[0].n >= MAX_SECRETS) {
      res.status(400).json({ message: `A repository can hold at most ${MAX_SECRETS} secrets` });
      return;
    }
    await pool.query(
      `INSERT INTO repo_secrets (repo_id, key, value_enc, updated) VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo_id, key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated = EXCLUDED.updated`,
      [repo.id, key, encryptSecret(value), Date.now()],
    );
    res.json({ key, updated: Date.now() });
  }));

  api.delete(`${R}/actions/secrets/:key`, auth, guard(async (req, res) => {
    const repo = await writable(req, res);
    if (!repo) return;
    await pool.query('DELETE FROM repo_secrets WHERE repo_id = $1 AND key = $2', [repo.id, String(req.params.key)]);
    res.json({ ok: true });
  }));

  // --- commit statuses & PR checks --------------------------------------------------------

  api.get(`${R}/commits/:sha/status`, optionalAuth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    const { store } = await getRuntime();
    const statuses = await store.listStatuses(repo.id, String(req.params.sha));
    res.json({ sha: String(req.params.sha), state: combinedState(statuses), statuses: statuses.map(statusPayload) });
  }));

  // External CI can report too (GitHub-compatible body), with a PAT that has
  // write access to the repository.
  api.post(`${R}/statuses/:sha`, auth, guard(async (req, res) => {
    const repo = await writable(req, res);
    if (!repo) return;
    const sha = String(req.params.sha);
    const state = String(req.body?.state || '');
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      res.status(400).json({ message: 'sha must be a full 40-character commit id' });
      return;
    }
    if (!STATUS_STATES.has(state)) {
      res.status(400).json({ message: 'state must be pending, success, failure or error' });
      return;
    }
    const { store } = await getRuntime();
    const context = String(req.body?.context || 'default').slice(0, 255);
    await store.setStatus(repo.id, sha, context, state, String(req.body?.description || ''), String(req.body?.target_url || ''));
    res.status(201).json({ sha, context, state });
  }));

  api.get(`${R}/pullreq/:number/checks`, optionalAuth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    const { rows } = await pool.query('SELECT * FROM pull_requests WHERE repo_id = $1 AND number = $2', [
      repo.id,
      Number(req.params.number),
    ]);
    const pr = rows[0];
    if (!pr) {
      res.status(404).json({ message: 'Pull request not found' });
      return;
    }
    let sha = null;
    try {
      ({ sha } = await resolveRef(repo.space_uid, repo.uid, `refs/heads/${pr.source_branch}`));
    } catch {
      /* source branch deleted */
    }
    const { store } = await getRuntime();
    const statuses = sha ? await store.listStatuses(repo.id, sha) : [];
    res.json({
      sha,
      state: combinedState(statuses),
      required: Boolean(repo.require_checks),
      statuses: statuses.map(statusPayload),
    });
  }));

  // --- stars ---------------------------------------------------------------------------------

  const starCount = async repoId =>
    (await pool.query('SELECT count(*)::int AS n FROM repo_stars WHERE repo_id = $1', [repoId])).rows[0].n;

  api.put(`${R}/star`, auth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    await pool.query(
      'INSERT INTO repo_stars (repo_id, user_uid, created) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [repo.id, viewer(req).uid, Date.now()],
    );
    res.json({ starred: true, stars: await starCount(repo.id) });
  }));

  api.delete(`${R}/star`, auth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    await pool.query('DELETE FROM repo_stars WHERE repo_id = $1 AND user_uid = $2', [repo.id, viewer(req).uid]);
    res.json({ starred: false, stars: await starCount(repo.id) });
  }));

  // --- archive download ------------------------------------------------------------------------

  // GET /repos/{space}/{repo}/+/archive/{ref}.zip | .tar.gz
  api.get(`${R}/archive/*splat`, optionalAuth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    const tail = Array.isArray(req.params.splat) ? req.params.splat.join('/') : String(req.params.splat || '');
    const m = /^(.+)\.(zip|tar\.gz|tgz)$/.exec(tail);
    if (!m) {
      res.status(400).json({ message: 'Use {ref}.zip or {ref}.tar.gz' });
      return;
    }
    const [, ref, ext] = m;
    let sha;
    try {
      ({ sha } = await resolveRef(repo.space_uid, repo.uid, ref));
    } catch {
      res.status(404).json({ message: 'Ref not found' });
      return;
    }
    const slug = ref.replace(/[^A-Za-z0-9._-]+/g, '-');
    const base = `${repo.uid}-${slug}`;
    const format = ext === 'zip' ? 'zip' : 'tar.gz';
    const child = spawn('git', ['-C', repoDir(repo.space_uid, repo.uid), 'archive', `--format=${format}`, `--prefix=${base}/`, sha], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    res.set('Content-Type', ext === 'zip' ? 'application/zip' : 'application/gzip');
    res.set('Content-Disposition', `attachment; filename="${base}.${ext === 'zip' ? 'zip' : 'tar.gz'}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    child.stdout.pipe(res);
    child.on('error', () => res.destroy());
    child.on('close', code => {
      if (code !== 0) res.destroy();
    });
    req.on('close', () => child.kill());
  }));

  // --- file list (the "t" file finder) -----------------------------------------------------------

  api.get(`${R}/files`, optionalAuth, guard(async (req, res) => {
    const repo = await readable(req, res);
    if (!repo) return;
    const ref = String(req.query.git_ref || repo.default_branch);
    try {
      const safe = assertSafeRef(ref);
      const { stdout } = await exec(
        'git',
        ['-C', repoDir(repo.space_uid, repo.uid), 'ls-tree', '-r', '-z', '--name-only', safe, '--'],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const files = stdout.split('\0').filter(Boolean);
      res.json({ ref, truncated: files.length > MAX_FILES, files: files.slice(0, MAX_FILES) });
    } catch {
      res.json({ ref, truncated: false, files: [] });
    }
  }));

  return api;
}
