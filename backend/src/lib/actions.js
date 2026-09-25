// Nixre Actions — the CI/CD engine.
//
// A push, pull request, cron tick or manual dispatch looks for workflow files
// in the repository at that commit (.nixre/workflows, then .gitea/workflows,
// then .github/workflows), creates a run per matching workflow, and executes
// its jobs in throwaway containers with the repository checked out.
//
// Runs are in-process like deployments: one nixre-core, jobs scheduled
// against a global concurrency limit, state in Postgres, live events on an
// in-memory bus (replayed to late SSE subscribers). A restart marks unfinished
// runs as interrupted (sweep()).
//
// All IO is injected — `store` (Postgres), `git`, `runner` (Docker) and
// `deploy` — so actions.test.js drives the whole engine with fakes.

import { EventEmitter } from 'node:events';
import {
  WORKFLOW_DIRS,
  ZERO_SHA,
  WorkflowError,
  parseWorkflow,
  matchesEvent,
  expandMatrix,
  matrixJobName,
  cronMatches,
  interpolate,
  evaluateIf,
  parseKeyValueFile,
  imageFor,
  stringify,
} from './workflowSpec.js';

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const BUS_BUFFER = 2000;
const WORKSPACE = '/workspace';
const STATE_DIR = '/tmp/_nixre';

/** Commit-status context for a job, e.g. "CI / test (20) (push)". */
export function statusContext(run, jobName) {
  return `${run.workflow_name} / ${jobName} (${run.event})`;
}

export function createActionsEngine({
  store,
  git,
  runner,
  deploy = null,
  decryptValue = v => v,
  now = () => Date.now(),
  concurrency = Number(process.env.NIXRE_ACTIONS_CONCURRENCY || 2),
  defaultImage = process.env.NIXRE_ACTIONS_DEFAULT_IMAGE || 'node:22-bookworm',
  sandboxImage = process.env.SANDBOX_IMAGE || 'nixre-agent-sandbox:latest',
  defaultTimeoutMinutes = Number(process.env.NIXRE_ACTIONS_JOB_TIMEOUT_MIN || 60),
  maxTimeoutMinutes = Number(process.env.NIXRE_ACTIONS_MAX_TIMEOUT_MIN || 360),
  serverUrl = process.env.NIXRE_PUBLIC_URL || '',
  logFlushMs = 1500,
  deployPollMs = 2000,
}) {
  /** runId -> in-memory state for an unfinished run */
  const active = new Map();
  /** FIFO of {state, job} waiting for a concurrency slot */
  const ready = [];
  let running = 0;
  const buses = new Map();
  const scheduleCache = new Map(); // repoId -> { sha, entries: [{path, crons}] }
  let lastScheduleMinute = null;

  // --- event bus ------------------------------------------------------------------

  function busFor(runId) {
    let bus = buses.get(runId);
    if (!bus) {
      bus = { emitter: new EventEmitter(), buffer: [] };
      bus.emitter.setMaxListeners(100);
      buses.set(runId, bus);
    }
    return bus;
  }
  function publish(runId, event) {
    const bus = busFor(runId);
    const evt = { ...event, ts: now() };
    bus.buffer.push(evt);
    if (bus.buffer.length > BUS_BUFFER) bus.buffer.splice(0, bus.buffer.length - BUS_BUFFER);
    bus.emitter.emit('event', evt);
  }
  /** Subscribe to a run's live events; replays what this process buffered. */
  function subscribe(runId, send) {
    const bus = busFor(runId);
    for (const evt of bus.buffer) {
      try {
        send(evt);
      } catch {
        /* closed */
      }
    }
    const on = evt => {
      try {
        send(evt);
      } catch {
        /* closed */
      }
    };
    bus.emitter.on('event', on);
    return () => bus.emitter.off('event', on);
  }

  // --- discovery ------------------------------------------------------------------

  /**
   * Workflow files at a commit: the first directory in WORKFLOW_DIRS that has
   * any .yml/.yaml file. Each entry is { path, workflow } or { path, error }.
   */
  async function discover(space, repo, sha) {
    for (const dir of WORKFLOW_DIRS) {
      let entries;
      try {
        entries = await git.listDir(space, repo, sha, dir);
      } catch {
        continue;
      }
      const files = entries
        .filter(e => e.type === 'file' && /\.ya?ml$/i.test(e.name))
        .map(e => `${dir}/${e.name}`)
        .sort();
      if (files.length === 0) continue;
      const out = [];
      for (const path of files) {
        try {
          const text = await git.readFile(space, repo, sha, path);
          out.push({ path, workflow: parseWorkflow(text, path) });
        } catch (err) {
          out.push({ path, error: err instanceof WorkflowError ? err.message : `Could not read ${path}: ${err.message}` });
        }
      }
      return out;
    }
    return [];
  }

  // --- triggers -------------------------------------------------------------------

  async function onPush({ space, repo, ref, before, after, pusher }) {
    if (!after || after === ZERO_SHA) return []; // deletion
    const repoRow = await store.findRepo(space, repo);
    if (!repoRow) return [];
    let changedFiles = null;
    if (before && before !== ZERO_SHA && String(ref).startsWith('refs/heads/')) {
      changedFiles = await git.changedFiles(space, repo, before, after).catch(() => null);
    }
    const found = await discover(space, repo, after);
    const runs = [];
    for (const entry of found) {
      if (entry.error) {
        runs.push(await recordInvalid(repoRow, entry, { event: 'push', ref, sha: after, actor: pusher }));
        continue;
      }
      if (!matchesEvent(entry.workflow, { name: 'push', ref, changedFiles })) continue;
      runs.push(await createRun(repoRow, entry.workflow, { event: 'push', ref, sha: after, actor: pusher }));
    }
    if (String(ref).startsWith('refs/heads/')) {
      const branch = String(ref).slice(11);
      if (branch === repoRow.default_branch) scheduleCache.delete(Number(repoRow.id));
      const prs = await store.openPrsForBranch(repoRow.id, branch);
      for (const pr of prs) {
        runs.push(...(await onPullRequest({ space, repo, pr, action: 'synchronize', actor: pusher, sha: after })));
      }
    }
    return runs;
  }

  async function onPullRequest({ space, repo, pr, action, actor, sha }) {
    const repoRow = await store.findRepo(space, repo);
    if (!repoRow) return [];
    const head = sha || (await git.resolveRef(space, repo, `refs/heads/${pr.source_branch}`)).sha;
    const changedFiles = await git.changedFiles(space, repo, pr.target_branch, head, { mergeBase: true }).catch(() => null);
    const found = await discover(space, repo, head);
    const runs = [];
    for (const entry of found) {
      if (entry.error) continue; // already reported on the push
      if (!matchesEvent(entry.workflow, { name: 'pull_request', action, baseBranch: pr.target_branch, changedFiles })) continue;
      runs.push(
        await createRun(repoRow, entry.workflow, {
          event: 'pull_request',
          ref: `refs/pull/${pr.number}/head`,
          sha: head,
          prNumber: Number(pr.number),
          pr,
          actor: actor || pr.author_uid,
        }),
      );
    }
    return runs;
  }

  function normalizeInputs(wf, inputs) {
    const defs = wf.on.workflow_dispatch?.inputs || {};
    const out = {};
    for (const [name, def] of Object.entries(defs)) {
      const raw = inputs?.[name];
      let value = raw === undefined || raw === null || raw === '' ? def.default : String(raw);
      if (def.required && (value === undefined || value === '')) {
        throw Object.assign(new Error(`Input '${name}' is required`), { status: 400 });
      }
      if (def.type === 'boolean') value = String(value === true || value === 'true');
      if (def.type === 'choice' && value !== '' && def.options.length && !def.options.includes(value)) {
        throw Object.assign(new Error(`Input '${name}' must be one of: ${def.options.join(', ')}`), { status: 400 });
      }
      if (def.type === 'number' && value !== '' && !Number.isFinite(Number(value))) {
        throw Object.assign(new Error(`Input '${name}' must be a number`), { status: 400 });
      }
      out[name] = value ?? '';
    }
    return out;
  }

  /** Manual run ("Run workflow" button). */
  async function dispatch({ repoRow, workflowPath, ref, inputs, actor }) {
    const branchOrRef = String(ref || repoRow.default_branch);
    let fullRef = branchOrRef;
    let resolved;
    for (const candidate of [`refs/heads/${branchOrRef}`, `refs/tags/${branchOrRef}`, branchOrRef]) {
      try {
        resolved = await git.resolveRef(repoRow.space_uid, repoRow.uid, candidate);
        fullRef = candidate;
        break;
      } catch {
        /* try the next form */
      }
    }
    if (!resolved) throw Object.assign(new Error(`Ref '${branchOrRef}' not found`), { status: 404 });
    const found = await discover(repoRow.space_uid, repoRow.uid, resolved.sha);
    const entry = found.find(e => e.path === workflowPath);
    if (!entry) throw Object.assign(new Error(`Workflow '${workflowPath}' not found at ${branchOrRef}`), { status: 404 });
    if (entry.error) throw Object.assign(new Error(entry.error), { status: 422 });
    if (!entry.workflow.on.workflow_dispatch) {
      throw Object.assign(new Error("This workflow has no 'workflow_dispatch' trigger"), { status: 422 });
    }
    return createRun(repoRow, entry.workflow, {
      event: 'workflow_dispatch',
      ref: fullRef,
      sha: resolved.sha,
      actor,
      inputs: normalizeInputs(entry.workflow, inputs),
    });
  }

  /** Run the same workflow again for the same commit and event. */
  async function rerun(runRow, actor) {
    const repoRow = await store.getRepo(runRow.repo_id);
    const found = await discover(repoRow.space_uid, repoRow.uid, runRow.sha);
    const entry = found.find(e => e.path === runRow.workflow_path);
    if (!entry) throw Object.assign(new Error('The workflow file no longer exists at this commit'), { status: 404 });
    if (entry.error) throw Object.assign(new Error(entry.error), { status: 422 });
    return createRun(repoRow, entry.workflow, {
      event: runRow.event,
      ref: runRow.ref,
      sha: runRow.sha,
      prNumber: runRow.pr_number,
      actor,
      inputs: runRow.inputs || {},
    });
  }

  /** Cron: call once a minute. Scans each repo's default branch. */
  async function scheduleTick(date = new Date(now())) {
    const minute = Math.floor(date.getTime() / 60000);
    if (lastScheduleMinute === minute) return [];
    lastScheduleMinute = minute;
    const runs = [];
    for (const repoRow of await store.listRepos()) {
      let head;
      try {
        head = (await git.resolveRef(repoRow.space_uid, repoRow.uid, `refs/heads/${repoRow.default_branch}`)).sha;
      } catch {
        continue; // empty repo
      }
      let cached = scheduleCache.get(Number(repoRow.id));
      if (!cached || cached.sha !== head) {
        const found = await discover(repoRow.space_uid, repoRow.uid, head).catch(() => []);
        cached = {
          sha: head,
          entries: found.filter(e => e.workflow?.on.schedule).map(e => ({ workflow: e.workflow })),
        };
        scheduleCache.set(Number(repoRow.id), cached);
      }
      for (const { workflow } of cached.entries) {
        const cron = workflow.on.schedule.find(c => {
          try {
            return cronMatches(c, date);
          } catch {
            return false;
          }
        });
        if (!cron) continue;
        runs.push(
          await createRun(repoRow, workflow, {
            event: 'schedule',
            ref: `refs/heads/${repoRow.default_branch}`,
            sha: head,
            actor: 'schedule',
            schedule: cron,
          }),
        );
      }
    }
    return runs;
  }

  // --- runs ---------------------------------------------------------------------------

  function targetUrl(repoRow, runNumber) {
    return `${serverUrl}/${repoRow.space_uid}/${repoRow.uid}?tab=actions&run=${runNumber}`;
  }

  async function recordInvalid(repoRow, entry, { event, ref, sha, actor }) {
    const ts = now();
    const run = await store.createRun(repoRow.id, {
      workflow_path: entry.path,
      workflow_name: entry.path.split('/').pop(),
      event,
      ref,
      sha,
      actor,
      status: 'completed',
      conclusion: 'failure',
      error: `Invalid workflow file: ${entry.error}`,
      created: ts,
      started: ts,
      finished: ts,
    });
    await store.setStatus(repoRow.id, sha, `${run.workflow_name} (${event})`, 'error', 'Invalid workflow file', targetUrl(repoRow, run.run_number), ts);
    return run;
  }

  async function createRun(repoRow, wf, { event, ref, sha, prNumber = null, pr = null, actor = '', inputs = {}, schedule = null }) {
    const ts = now();
    const run = await store.createRun(repoRow.id, {
      workflow_path: wf.path,
      workflow_name: wf.name,
      event,
      ref,
      sha,
      pr_number: prNumber,
      actor,
      inputs,
      created: ts,
    });
    const state = {
      run,
      repo: repoRow,
      wf,
      pr,
      schedule,
      jobs: new Map(), // jobId -> {row, def, combo, outputs, controller}
      cancelled: false,
      secrets: null,
    };
    active.set(Number(run.id), state);
    try {
      for (const def of wf.jobs) {
        if (typeof def.matrix === 'string') throw new WorkflowError(`jobs.${def.id}: a matrix built from an expression is not supported`);
        const combos = expandMatrix(def.matrix);
        for (const combo of combos) {
          const row = await store.createJob(run.id, {
            job_key: def.id,
            name: matrixJobName(def.name, combo),
            matrix: combo,
            needs: def.needs,
            steps: def.steps.map(s => ({ name: s.name, status: 'queued', conclusion: null })),
          });
          state.jobs.set(Number(row.id), { row, def, combo, outputs: {}, controller: null });
          await store.setStatus(repoRow.id, sha, statusContext(run, row.name), 'pending', 'Queued', targetUrl(repoRow, run.run_number), ts);
        }
      }
    } catch (err) {
      active.delete(Number(run.id));
      const message = err instanceof WorkflowError ? err.message : `Could not start: ${err.message}`;
      state.run = await store.updateRun(run.id, { status: 'completed', conclusion: 'failure', error: message, finished: now() });
      for (const j of state.jobs.values()) {
        await store.updateJob(j.row.id, { status: 'completed', conclusion: 'skipped' });
        await store.setStatus(repoRow.id, sha, statusContext(run, j.row.name), 'error', message, targetUrl(repoRow, run.run_number));
      }
      return state.run;
    }
    publish(Number(run.id), { type: 'run', status: 'queued' });
    advance(state);
    return run;
  }

  /** Queue every job whose `needs` are complete; finish the run when done. */
  function advance(state) {
    const all = [...state.jobs.values()];
    for (const j of all) {
      if (j.row.status !== 'queued' || j.enqueued) continue;
      const deps = all.filter(o => j.def.needs.includes(o.def.id));
      if (deps.some(d => d.row.status !== 'completed')) continue;
      j.enqueued = true;
      ready.push({ state, job: j });
    }
    pump();
    if (all.every(j => j.row.status === 'completed')) void finishRun(state);
  }

  function pump() {
    while (running < concurrency && ready.length) {
      const { state, job } = ready.shift();
      running++;
      void runJob(state, job)
        .catch(err => console.error(`actions job#${job.row.id} crashed:`, err.message))
        .finally(() => {
          running--;
          advance(state);
          pump();
        });
    }
  }

  async function finishRun(state) {
    if (state.finishing) return;
    state.finishing = true;
    const jobs = [...state.jobs.values()];
    let conclusion = 'success';
    if (state.cancelled) conclusion = 'cancelled';
    else if (jobs.some(j => j.row.conclusion === 'failure' && !j.def.continueOnError)) conclusion = 'failure';
    else if (jobs.some(j => j.row.conclusion === 'cancelled')) conclusion = 'cancelled';
    else if (jobs.every(j => j.row.conclusion === 'skipped')) conclusion = 'skipped';
    state.run = await store.updateRun(state.run.id, {
      status: 'completed',
      conclusion,
      finished: now(),
      ...(state.run.started ? {} : { started: now() }),
    });
    active.delete(Number(state.run.id));
    publish(Number(state.run.id), { type: 'run', status: 'completed', conclusion });
    publish(Number(state.run.id), { type: 'end' });
  }

  // --- jobs -----------------------------------------------------------------------------

  function githubContext(state) {
    const { run, repo, pr } = state;
    const ref = run.ref;
    const refName = ref.replace(/^refs\/(heads|tags)\//, '').replace(/^refs\/pull\/(\d+)\/head$/, '$1/merge');
    return {
      sha: run.sha,
      ref,
      ref_name: refName,
      ref_type: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
      event_name: run.event,
      actor: run.actor,
      triggering_actor: run.actor,
      repository: `${repo.space_uid}/${repo.uid}`,
      repository_owner: repo.space_uid,
      run_id: String(run.id),
      run_number: String(run.run_number),
      run_attempt: '1',
      workflow: run.workflow_name,
      workflow_ref: `${repo.space_uid}/${repo.uid}/${run.workflow_path}@${ref}`,
      head_ref: pr?.source_branch || '',
      base_ref: pr?.target_branch || '',
      server_url: serverUrl,
      api_url: `${serverUrl}/api/v1`,
      workspace: WORKSPACE,
      event: {
        inputs: run.inputs || {},
        schedule: state.schedule || undefined,
        pull_request: pr
          ? { number: Number(pr.number), title: pr.title, head: { ref: pr.source_branch, sha: run.sha }, base: { ref: pr.target_branch } }
          : undefined,
        repository: { default_branch: repo.default_branch, full_name: `${repo.space_uid}/${repo.uid}` },
      },
    };
  }

  function githubEnv(gh) {
    return {
      CI: 'true',
      NIXRE_ACTIONS: 'true',
      GITHUB_ACTIONS: 'true',
      GITEA_ACTIONS: 'true',
      GITHUB_SHA: gh.sha,
      GITHUB_REF: gh.ref,
      GITHUB_REF_NAME: gh.ref_name,
      GITHUB_REF_TYPE: gh.ref_type,
      GITHUB_EVENT_NAME: gh.event_name,
      GITHUB_ACTOR: gh.actor,
      GITHUB_REPOSITORY: gh.repository,
      GITHUB_REPOSITORY_OWNER: gh.repository_owner,
      GITHUB_RUN_ID: gh.run_id,
      GITHUB_RUN_NUMBER: gh.run_number,
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_WORKFLOW: gh.workflow,
      GITHUB_HEAD_REF: gh.head_ref,
      GITHUB_BASE_REF: gh.base_ref,
      GITHUB_SERVER_URL: gh.server_url,
      GITHUB_API_URL: gh.api_url,
      GITHUB_WORKSPACE: WORKSPACE,
      GITHUB_ENV: `${STATE_DIR}/env`,
      GITHUB_OUTPUT: `${STATE_DIR}/output`,
      GITHUB_PATH: `${STATE_DIR}/path`,
      GITHUB_STEP_SUMMARY: `${STATE_DIR}/summary`,
      RUNNER_OS: 'Linux',
      RUNNER_ARCH: 'X64',
      RUNNER_TEMP: '/tmp',
      NIXRE_SHA: gh.sha,
      NIXRE_REF: gh.ref,
      NIXRE_REPOSITORY: gh.repository,
      NIXRE_RUN_NUMBER: gh.run_number,
    };
  }

  async function loadSecrets(state) {
    if (state.secrets) return state.secrets;
    const out = {};
    for (const row of await store.getSecrets(state.repo.id)) {
      try {
        out[row.key] = decryptValue(row.value_enc);
      } catch {
        /* undecryptable secret: behaves as unset */
      }
    }
    state.secrets = out;
    return out;
  }

  async function runJob(state, job) {
    const { run, repo } = state;
    const jobId = Number(job.row.id);
    if (job.row.status === 'completed') return; // cancelled while queued
    const context = statusContext(run, job.row.name);
    const url = targetUrl(repo, run.run_number);

    // --- log plumbing: masked, capped, flushed periodically ---
    const secrets = await loadSecrets(state);
    if (job.row.status === 'completed') return;
    const masks = Object.values(secrets)
      .flatMap(v => [v, ...String(v).split(/\r?\n/)])
      .filter(v => v && v.length >= 3)
      .sort((a, b) => b.length - a.length);
    let log = '';
    let truncated = false;
    let currentStep = -1;
    let dirty = false;
    const mask = line => {
      let out = line;
      for (const m of masks) if (out.includes(m)) out = out.split(m).join('***');
      return out;
    };
    const append = text => {
      log += text;
      if (log.length > MAX_LOG_BYTES) {
        log = log.slice(log.length - MAX_LOG_BYTES);
        truncated = true;
      }
      dirty = true;
    };
    const writeLine = raw => {
      const line = mask(String(raw).replace(/\r$/, ''));
      append(`${line}\n`);
      publish(Number(run.id), { type: 'log', jobId, step: currentStep, line });
    };
    const marker = idx => {
      currentStep = idx;
      append(`##[step:${idx}]\n`);
    };
    const flush = async () => {
      if (!dirty) return;
      dirty = false;
      await store.updateJob(jobId, { log: truncated ? `[log truncated to the last 2 MB]\n${log}` : log }).catch(() => {});
    };
    const flushTimer = setInterval(() => void flush(), logFlushMs);
    flushTimer.unref?.();

    const steps = job.def.steps.map(s => ({ name: s.name, status: 'queued', conclusion: null, started: null, finished: null }));
    const saveSteps = async () => {
      job.row = await store.updateJob(jobId, { steps });
      publish(Number(run.id), { type: 'job', jobId, status: job.row.status, conclusion: job.row.conclusion, steps });
    };

    // A dependency's result folds its matrix legs: any failure wins, then
    // cancelled, then skipped; success only if every leg succeeded.
    const rank = { failure: 3, cancelled: 2, skipped: 1, success: 0 };
    const needs = {};
    for (const d of [...state.jobs.values()].filter(o => job.def.needs.includes(o.def.id))) {
      const prev = needs[d.def.id];
      const result = d.def.continueOnError && d.row.conclusion === 'failure' ? 'success' : d.row.conclusion || 'skipped';
      needs[d.def.id] = {
        result: prev && rank[prev.result] >= rank[result] ? prev.result : result,
        outputs: { ...(prev?.outputs || {}), ...d.outputs },
      };
    }
    const worst = Object.values(needs).reduce((w, n) => (rank[n.result] > rank[w] ? n.result : w), 'success');
    // success() is false for any non-success need; failure() only when one failed.
    const depStatus = state.cancelled ? 'cancelled' : worst;

    const ctx = {
      github: githubContext(state),
      env: {},
      secrets,
      inputs: run.inputs || {},
      matrix: job.combo,
      needs,
      steps: {},
      job: { status: 'success' },
      runner: { os: 'Linux', arch: 'X64', temp: '/tmp', name: 'nixre' },
      vars: {},
      strategy: { 'fail-fast': job.def.failFast, 'job-total': 1, 'job-index': 0 },
      status: depStatus,
    };

    const finishJob = async (conclusion, description) => {
      clearInterval(flushTimer);
      dirty = true;
      await flush();
      job.row = await store.updateJob(jobId, { status: 'completed', conclusion, steps, finished: now() });
      const statusState = conclusion === 'success' || conclusion === 'skipped' ? 'success' : conclusion === 'cancelled' ? 'error' : 'failure';
      await store.setStatus(repo.id, run.sha, context, statusState, description, url);
      publish(Number(run.id), { type: 'job', jobId, status: 'completed', conclusion, steps });
    };

    // Job-level `if:` (default: all needs succeeded).
    let runIt;
    try {
      runIt = !state.cancelled && evaluateIf(job.def.if, ctx);
    } catch (err) {
      marker(-1);
      writeLine(`Error evaluating 'if': ${err.message}`);
      await finishJob('failure', 'Invalid if: expression');
      return;
    }
    if (!runIt) {
      for (const s of steps) {
        s.status = 'completed';
        s.conclusion = 'skipped';
      }
      await finishJob(state.cancelled ? 'cancelled' : 'skipped', state.cancelled ? 'Cancelled' : 'Skipped');
      return;
    }

    const controller = new AbortController();
    job.controller = controller;
    const startedAt = now();
    job.row = await store.updateJob(jobId, { status: 'running', started: startedAt });
    if (!state.run.started) state.run = await store.updateRun(run.id, { status: 'running', started: startedAt });
    publish(Number(run.id), { type: 'job', jobId, status: 'running', conclusion: null, steps });
    publish(Number(run.id), { type: 'run', status: 'running' });
    await store.setStatus(repo.id, run.sha, context, 'pending', 'Running', url);

    const timeoutMin = Math.min(job.def.timeoutMinutes ?? defaultTimeoutMinutes, maxTimeoutMinutes);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMin * 60_000);
    timer.unref?.();

    let handle = null;
    let jobStatus = 'success';
    let failedReason = '';
    const envFromFiles = {};
    const pathAdditions = [];
    try {
      // --- set up job ---
      marker(-1);
      ctx.env = {};
      for (const [k, v] of Object.entries(state.wf.env)) ctx.env[k] = interpolate(v, ctx);
      for (const [k, v] of Object.entries(job.def.env)) ctx.env[k] = interpolate(v, ctx);
      const withMatrix = {
        ...job.def,
        runsOn: interpolate(job.def.runsOn, ctx),
        container: job.def.container ? { ...job.def.container, image: interpolate(job.def.container.image, ctx) } : null,
      };
      const image = imageFor(withMatrix, { defaultImage, sandboxImage });
      await store.updateJob(jobId, { image });
      writeLine(`Job '${job.row.name}' in ${image}`);
      writeLine(`Commit ${run.sha.slice(0, 12)} on ${run.ref}, triggered by ${run.event}${run.actor ? ` (${run.actor})` : ''}`);
      const containerEnv = {};
      for (const [k, v] of Object.entries(job.def.container?.env || {})) containerEnv[k] = interpolate(v, ctx);
      handle = await runner.start({
        image,
        space: repo.space_uid,
        repo: repo.uid,
        sha: run.sha,
        runId: Number(run.id),
        jobId,
        env: containerEnv,
        signal: controller.signal,
        onLog: writeLine,
      });
      const baseEnv = { ...githubEnv(ctx.github), ...containerEnv };

      for (let i = 0; i < job.def.steps.length; i++) {
        const def = job.def.steps[i];
        const s = steps[i];
        if (controller.signal.aborted) jobStatus = timedOut ? 'failure' : 'cancelled';
        ctx.job.status = jobStatus;
        ctx.status = jobStatus;
        let doRun;
        try {
          doRun = !controller.signal.aborted && evaluateIf(def.if, ctx);
        } catch (err) {
          marker(i);
          writeLine(`Error evaluating 'if': ${err.message}`);
          doRun = false;
          jobStatus = 'failure';
        }
        if (!doRun) {
          s.status = 'completed';
          s.conclusion = 'skipped';
          if (def.id) ctx.steps[def.id] = { outcome: 'skipped', conclusion: 'skipped', outputs: {} };
          continue;
        }
        marker(i);
        s.status = 'running';
        s.started = now();
        await saveSteps();
        let outcome = 'success';
        let outputs = {};
        try {
          const stepEnv = {};
          for (const [k, v] of Object.entries(def.env)) stepEnv[k] = interpolate(v, ctx);
          if (def.action === 'checkout') {
            writeLine(`Repository ${ctx.github.repository} is checked out at ${WORKSPACE} (${run.sha.slice(0, 12)})`);
          } else if (def.action === 'deploy') {
            outcome = await runDeployStep(state, def, ctx, writeLine, controller.signal);
          } else {
            const script = interpolate(def.run, ctx);
            const shell = def.shell || null;
            writeLine(`$ ${script.split('\n')[0]}${script.includes('\n') ? ' ...' : ''}`);
            const env = { ...baseEnv, ...ctx.env, ...envFromFiles, ...stepEnv };
            if (pathAdditions.length) env.NIXRE_PATH_PREPEND = pathAdditions.slice().reverse().join(':');
            const stepTimeout = def.timeoutMinutes ? def.timeoutMinutes * 60_000 : null;
            const code = await runner.exec(handle, {
              script,
              shell,
              env,
              workdir: def.workingDirectory ? `${WORKSPACE}/${interpolate(def.workingDirectory, ctx)}`.replace(/\/+/g, '/') : WORKSPACE,
              onLine: writeLine,
              signal: controller.signal,
              timeoutMs: stepTimeout,
            });
            if (code !== 0) {
              outcome = 'failure';
              writeLine(controller.signal.aborted ? (timedOut ? `Timed out after ${timeoutMin} minutes` : 'Cancelled') : `Process exited with code ${code}`);
            }
            const files = await runner.collectFiles(handle).catch(() => ({}));
            outputs = parseKeyValueFile(files.output || '');
            Object.assign(envFromFiles, parseKeyValueFile(files.env || ''));
            for (const p of String(files.path || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)) pathAdditions.push(p);
          }
        } catch (err) {
          outcome = 'failure';
          writeLine(`Error: ${err.message}`);
        }
        if (controller.signal.aborted && outcome !== 'success') outcome = timedOut ? 'failure' : 'cancelled';
        const conclusion = outcome === 'failure' && def.continueOnError ? 'success' : outcome;
        s.status = 'completed';
        s.conclusion = conclusion;
        s.finished = now();
        if (def.id) ctx.steps[def.id] = { outcome, conclusion, outputs };
        if (conclusion === 'failure') {
          jobStatus = 'failure';
          failedReason = failedReason || `Step '${def.name}' failed`;
        } else if (conclusion === 'cancelled') jobStatus = 'cancelled';
        await saveSteps();
      }

      // Job outputs for dependent jobs.
      ctx.status = jobStatus;
      for (const [k, v] of Object.entries(job.def.outputs)) {
        try {
          job.outputs[k] = stringify(interpolate(v, ctx));
        } catch {
          job.outputs[k] = '';
        }
      }
    } catch (err) {
      jobStatus = controller.signal.aborted && !timedOut ? 'cancelled' : 'failure';
      failedReason = err.message;
      if (currentStep < 0) marker(-1);
      writeLine(`Error: ${err.message}`);
    } finally {
      clearTimeout(timer);
      if (handle) {
        marker(job.def.steps.length);
        writeLine('Cleaning up the job container');
        await runner.destroy(handle).catch(() => {});
      }
    }
    if (timedOut) {
      jobStatus = 'failure';
      failedReason = `Timed out after ${timeoutMin} minutes`;
    }
    for (const s of steps) {
      if (s.status !== 'completed') {
        s.status = 'completed';
        s.conclusion = jobStatus === 'cancelled' ? 'cancelled' : 'skipped';
      }
    }
    const description =
      jobStatus === 'success' ? `Successful in ${Math.max(1, Math.round((now() - startedAt) / 1000))}s` : jobStatus === 'cancelled' ? 'Cancelled' : failedReason || 'Failed';
    await finishJob(jobStatus, description);

    // fail-fast: a failed matrix leg cancels its queued/running siblings.
    if (jobStatus === 'failure' && job.def.failFast && job.def.matrix) {
      for (const other of state.jobs.values()) {
        if (other === job || other.def.id !== job.def.id || other.row.status === 'completed') continue;
        other.controller?.abort();
        if (other.row.status === 'queued') await skipQueued(state, other, 'cancelled', 'Cancelled by fail-fast');
      }
    }
  }

  async function skipQueued(state, job, conclusion, description) {
    const idx = ready.findIndex(r => r.job === job);
    if (idx >= 0) ready.splice(idx, 1);
    job.enqueued = true;
    const steps = job.def.steps.map(s => ({ name: s.name, status: 'completed', conclusion: 'skipped' }));
    job.row = await store.updateJob(job.row.id, { status: 'completed', conclusion, steps, finished: now() });
    await store.setStatus(state.repo.id, state.run.sha, statusContext(state.run, job.row.name), conclusion === 'cancelled' ? 'error' : 'success', description, targetUrl(state.repo, state.run.run_number));
    publish(Number(state.run.id), { type: 'job', jobId: Number(job.row.id), status: 'completed', conclusion, steps });
  }

  // `uses: nixre/deploy@v1` — release a deploy service at this commit.
  async function runDeployStep(state, def, ctx, writeLine, signal) {
    if (!deploy) throw new Error('Deployments are not available on this instance');
    const name = interpolate(def.with.service, ctx);
    const service = await store.findService(state.repo.id, name);
    if (!service) throw new Error(`No deploy service named '${name}' in this repository`);
    writeLine(`Deploying service '${name}' at ${state.run.sha.slice(0, 12)}`);
    // The deploy bus replays its buffer to new subscribers; only relay lines
    // from this deployment onwards.
    const since = now();
    const unsubscribe = deploy.subscribe
      ? deploy.subscribe(service.id, evt => {
          if (evt.type === 'log' && evt.line && (evt.ts ?? since) >= since) writeLine(`[deploy] ${evt.line}`);
        })
      : () => {};
    try {
      const { deploymentId } = await deploy.start(service.id, { ref: state.run.sha, trigger: 'workflow' });
      if (!deploymentId) throw new Error('The service is stopped; start it before deploying from a workflow');
      if (String(def.with.wait ?? 'true') === 'false') {
        writeLine(`Deployment #${deploymentId} started (not waiting)`);
        return 'success';
      }
      for (;;) {
        if (signal.aborted) {
          await deploy.cancel?.(service.id).catch(() => {});
          return 'cancelled';
        }
        const dep = await store.getDeployment(deploymentId);
        if (dep && ['live', 'superseded'].includes(dep.status)) {
          writeLine(`Deployment #${deploymentId} is live`);
          return 'success';
        }
        if (dep && ['failed', 'cancelled'].includes(dep.status)) {
          writeLine(`Deployment #${deploymentId} ${dep.status}${dep.error ? `: ${dep.error}` : ''}`);
          return 'failure';
        }
        await new Promise(r => setTimeout(r, deployPollMs));
      }
    } finally {
      unsubscribe();
    }
  }

  // --- control ----------------------------------------------------------------------------

  async function cancel(runId) {
    const state = active.get(Number(runId));
    if (!state) return false;
    state.cancelled = true;
    for (const job of state.jobs.values()) {
      if (job.row.status === 'queued') await skipQueued(state, job, 'cancelled', 'Cancelled');
      else job.controller?.abort();
    }
    advance(state);
    return true;
  }

  /** Boot reconcile: close runs a previous process left unfinished. */
  async function sweep() {
    const jobs = await store.interruptUnfinished(new Set(active.keys()), now());
    for (const j of jobs) {
      await store
        .setStatus(j.repo_id, j.sha, `${j.workflow_name} / ${j.name} (${j.event})`, 'error', 'Interrupted by a restart')
        .catch(() => {});
    }
    await runner.cleanupOrphans?.(new Set([...active.values()].flatMap(s => [...s.jobs.keys()]))).catch(() => {});
    return jobs.length;
  }

  async function waitIdle() {
    while (active.size > 0 || running > 0) await new Promise(r => setTimeout(r, 5));
  }

  return {
    discover,
    onPush,
    onPullRequest,
    dispatch,
    rerun,
    cancel,
    scheduleTick,
    sweep,
    subscribe,
    isActive: runId => active.has(Number(runId)),
    waitIdle,
  };
}
