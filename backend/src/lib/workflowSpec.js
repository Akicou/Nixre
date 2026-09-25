// Workflow files — parsing, trigger matching, matrix expansion, cron, and
// `${{ }}` expressions for Nixre Actions.
//
// Pure: no IO, no Docker, no database. The engine (lib/actions.js) feeds it
// file contents and event facts; everything here is unit-tested directly.
//
// The syntax is the GitHub Actions / Gitea Actions subset that makes sense for
// a self-hosted runner that executes `run:` steps in a container:
//   on: push | pull_request | schedule | workflow_dispatch  (+ filters)
//   env, jobs.<id>.{name, runs-on, container, needs, if, env, strategy.matrix,
//   timeout-minutes, continue-on-error, outputs, steps}
//   steps: run | uses (actions/checkout, nixre/deploy), name, id, if, env,
//   shell, working-directory, continue-on-error, timeout-minutes, with
// Anything else is reported as an error rather than silently ignored.

import YAML from 'yaml';

/** Directories searched for workflows, first one with any .yml wins. */
export const WORKFLOW_DIRS = ['.nixre/workflows', '.gitea/workflows', '.github/workflows'];

export const EVENTS = ['push', 'pull_request', 'schedule', 'workflow_dispatch'];

export const ZERO_SHA = '0000000000000000000000000000000000000000';

const MAX_JOBS = 64;
const MAX_STEPS = 100;
const MAX_MATRIX = 64;

export class WorkflowError extends Error {}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function asList(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

function strMap(obj, where) {
  if (obj === undefined || obj === null) return {};
  if (!isObj(obj)) throw new WorkflowError(`${where} must be a mapping`);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

// --- parsing -------------------------------------------------------------------

function normalizeOn(raw) {
  if (raw === undefined) throw new WorkflowError("Missing 'on:' (which events start this workflow)");
  let on = raw;
  if (typeof on === 'string') on = { [on]: null };
  else if (Array.isArray(on)) on = Object.fromEntries(on.map(e => [String(e), null]));
  if (!isObj(on)) throw new WorkflowError("'on:' must be an event name, a list, or a mapping");
  const out = {};
  for (const [event, cfgRaw] of Object.entries(on)) {
    if (!EVENTS.includes(event)) {
      throw new WorkflowError(`Unsupported event '${event}' (supported: ${EVENTS.join(', ')})`);
    }
    const cfg = cfgRaw ?? {};
    if (event === 'schedule') {
      if (!Array.isArray(cfg) || cfg.length === 0) throw new WorkflowError("'schedule:' must be a list of '- cron: ...' entries");
      out.schedule = cfg.map(entry => {
        const expr = String(entry?.cron ?? '').trim();
        parseCron(expr); // validates
        return expr;
      });
      continue;
    }
    if (!isObj(cfg)) throw new WorkflowError(`'${event}:' must be a mapping`);
    if (event === 'workflow_dispatch') {
      const inputs = {};
      for (const [name, def] of Object.entries(cfg.inputs ?? {})) {
        const d = isObj(def) ? def : {};
        const type = String(d.type ?? 'string');
        if (!['string', 'boolean', 'choice', 'number', 'environment'].includes(type)) {
          throw new WorkflowError(`Input '${name}' has unsupported type '${type}'`);
        }
        inputs[name] = {
          description: String(d.description ?? ''),
          required: Boolean(d.required),
          default: d.default === undefined || d.default === null ? '' : String(d.default),
          type,
          options: asList(d.options),
        };
      }
      out.workflow_dispatch = { inputs };
      continue;
    }
    const filters = {};
    for (const key of ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore', 'types']) {
      if (cfg[key] !== undefined) filters[key] = asList(cfg[key]);
    }
    if (filters.branches && filters['branches-ignore']) throw new WorkflowError(`'${event}' cannot use both branches and branches-ignore`);
    if (filters.tags && filters['tags-ignore']) throw new WorkflowError(`'${event}' cannot use both tags and tags-ignore`);
    if (filters.paths && filters['paths-ignore']) throw new WorkflowError(`'${event}' cannot use both paths and paths-ignore`);
    out[event] = filters;
  }
  return out;
}

function normalizeStep(raw, i, jobId) {
  const where = `jobs.${jobId}.steps[${i}]`;
  if (!isObj(raw)) throw new WorkflowError(`${where} must be a mapping`);
  const hasRun = raw.run !== undefined;
  const hasUses = raw.uses !== undefined;
  if (hasRun === hasUses) throw new WorkflowError(`${where} needs exactly one of 'run' or 'uses'`);
  const step = {
    id: raw.id === undefined ? null : String(raw.id),
    name: String(raw.name ?? (hasRun ? String(raw.run).split('\n')[0].slice(0, 80) : String(raw.uses))),
    if: raw.if === undefined ? null : String(raw.if),
    env: strMap(raw.env, `${where}.env`),
    continueOnError: raw['continue-on-error'] === true || raw['continue-on-error'] === 'true',
    timeoutMinutes: raw['timeout-minutes'] === undefined ? null : Number(raw['timeout-minutes']),
    workingDirectory: raw['working-directory'] === undefined ? null : String(raw['working-directory']),
  };
  if (hasRun) {
    step.run = String(raw.run);
    const shell = raw.shell === undefined ? null : String(raw.shell);
    if (shell && !['bash', 'sh', 'python', 'node'].includes(shell)) {
      throw new WorkflowError(`${where}: unsupported shell '${shell}' (bash, sh, python, node)`);
    }
    step.shell = shell;
  } else {
    step.uses = String(raw.uses).trim();
    step.with = strMap(raw.with, `${where}.with`);
    const action = usesKind(step.uses);
    if (!action) {
      throw new WorkflowError(
        `${where}: '${step.uses}' is not available. Nixre runs 'run:' steps; the built-in actions are actions/checkout and nixre/deploy`,
      );
    }
    step.action = action;
    if (action === 'deploy' && !step.with.service) {
      throw new WorkflowError(`${where}: nixre/deploy needs 'with: service: <service name>'`);
    }
  }
  if (step.timeoutMinutes !== null && !(step.timeoutMinutes > 0)) {
    throw new WorkflowError(`${where}: timeout-minutes must be a positive number`);
  }
  return step;
}

/** 'checkout' | 'deploy' | null for a `uses:` value. */
export function usesKind(uses) {
  const name = String(uses).split('@')[0].toLowerCase();
  if (name === 'actions/checkout') return 'checkout';
  if (name === 'nixre/deploy') return 'deploy';
  return null;
}

function normalizeJob(id, raw) {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id)) throw new WorkflowError(`Invalid job id '${id}'`);
  if (!isObj(raw)) throw new WorkflowError(`jobs.${id} must be a mapping`);
  if (raw.uses !== undefined) throw new WorkflowError(`jobs.${id}: reusable workflows ('uses' on a job) are not supported`);
  if (raw.services !== undefined) throw new WorkflowError(`jobs.${id}: 'services' containers are not supported yet`);
  const steps = raw.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new WorkflowError(`jobs.${id} has no steps`);
  if (steps.length > MAX_STEPS) throw new WorkflowError(`jobs.${id} has more than ${MAX_STEPS} steps`);
  let container = null;
  if (raw.container !== undefined) {
    const c = typeof raw.container === 'string' ? { image: raw.container } : raw.container;
    if (!isObj(c) || !c.image) throw new WorkflowError(`jobs.${id}.container needs an image`);
    container = { image: String(c.image), env: strMap(c.env, `jobs.${id}.container.env`) };
  }
  const matrix = raw.strategy?.matrix;
  if (matrix !== undefined && !isObj(matrix) && typeof matrix !== 'string') {
    throw new WorkflowError(`jobs.${id}.strategy.matrix must be a mapping`);
  }
  const timeout = raw['timeout-minutes'] === undefined ? null : Number(raw['timeout-minutes']);
  if (timeout !== null && !(timeout > 0)) throw new WorkflowError(`jobs.${id}: timeout-minutes must be a positive number`);
  return {
    id,
    name: raw.name === undefined ? id : String(raw.name),
    runsOn: raw['runs-on'] === undefined ? 'ubuntu-latest' : asList(raw['runs-on'])[0],
    container,
    needs: asList(raw.needs),
    if: raw.if === undefined ? null : String(raw.if),
    env: strMap(raw.env, `jobs.${id}.env`),
    matrix: matrix ?? null,
    failFast: raw.strategy?.['fail-fast'] !== false,
    maxParallel: raw.strategy?.['max-parallel'] === undefined ? null : Number(raw.strategy['max-parallel']),
    timeoutMinutes: timeout,
    continueOnError: raw['continue-on-error'] === true || raw['continue-on-error'] === 'true',
    outputs: strMap(raw.outputs, `jobs.${id}.outputs`),
    steps: steps.map((s, i) => normalizeStep(s, i, id)),
  };
}

/**
 * Parse and validate one workflow file. Throws WorkflowError with a message
 * meant for the repo owner.
 */
export function parseWorkflow(text, path = 'workflow.yml') {
  let doc;
  try {
    doc = YAML.parse(String(text), { maxAliasCount: 50, uniqueKeys: true });
  } catch (err) {
    throw new WorkflowError(`YAML error: ${String(err.message).split('\n')[0]}`);
  }
  if (!isObj(doc)) throw new WorkflowError('A workflow must be a YAML mapping');
  // YAML 1.1 parsers turn a bare `on:` key into `true`; `yaml` (1.2) keeps
  // "on", but accept both so files written for either parse the same.
  const onRaw = doc.on !== undefined ? doc.on : doc.true;
  const on = normalizeOn(onRaw);
  if (!isObj(doc.jobs) || Object.keys(doc.jobs).length === 0) throw new WorkflowError("Missing 'jobs:'");
  const ids = Object.keys(doc.jobs);
  if (ids.length > MAX_JOBS) throw new WorkflowError(`More than ${MAX_JOBS} jobs`);
  const jobs = ids.map(id => normalizeJob(id, doc.jobs[id]));
  for (const job of jobs) {
    for (const need of job.needs) {
      if (!ids.includes(need)) throw new WorkflowError(`jobs.${job.id} needs unknown job '${need}'`);
    }
  }
  jobOrder(jobs); // throws on cycles
  const fileName = path.split('/').pop();
  return {
    path,
    name: doc.name === undefined ? fileName : String(doc.name),
    on,
    env: strMap(doc.env, 'env'),
    jobs,
  };
}

/** Topological order of jobs; throws on a `needs` cycle. */
export function jobOrder(jobs) {
  const byId = new Map(jobs.map(j => [j.id, j]));
  const state = new Map();
  const order = [];
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') throw new WorkflowError(`Job dependency cycle: ${[...trail, id].join(' -> ')}`);
    state.set(id, 'visiting');
    for (const need of byId.get(id).needs) visit(need, [...trail, id]);
    state.set(id, 'done');
    order.push(id);
  };
  for (const j of jobs) visit(j.id, []);
  return order;
}

// --- trigger matching -------------------------------------------------------------

/** GitHub-style filter glob: `*` stops at `/`, `**` crosses it, `?` one char. */
export function globToRegExp(glob) {
  let re = '';
  const g = String(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++, (re += '(?:/)?');
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '+') re += '+';
    else re += c.replace(/[.^$|()[\]{}\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Apply an ordered include list with `!negations` (the last matching pattern
 * wins, as on GitHub).
 */
export function matchPatterns(value, patterns) {
  let matched = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globToRegExp(p.slice(1)).test(value)) matched = false;
    } else if (globToRegExp(p).test(value)) matched = true;
  }
  return matched;
}

function includeIgnore(value, include, ignore) {
  if (include) return matchPatterns(value, include);
  if (ignore) return !matchPatterns(value, ignore);
  return true;
}

function pathsMatch(filters, changedFiles) {
  if (!filters.paths && !filters['paths-ignore']) return true;
  // Unknown change set (new branch, first push): GitHub runs the workflow.
  if (!changedFiles) return true;
  if (filters.paths) return changedFiles.some(f => matchPatterns(f, filters.paths));
  return changedFiles.some(f => !matchPatterns(f, filters['paths-ignore']));
}

/**
 * Does this workflow run for an event?
 *
 * @param {object} wf       parsed workflow
 * @param {object} event
 *   push:          { name:'push', ref:'refs/heads/x'|'refs/tags/y', changedFiles?: string[]|null }
 *   pull_request:  { name:'pull_request', action:'opened'|'synchronize'|'reopened', baseBranch, changedFiles? }
 *   schedule:      { name:'schedule', cron }
 *   workflow_dispatch: { name:'workflow_dispatch' }
 */
export function matchesEvent(wf, event) {
  const cfg = wf.on[event.name];
  if (cfg === undefined) return false;
  if (event.name === 'workflow_dispatch') return true;
  if (event.name === 'schedule') return cfg.includes(event.cron);
  if (event.name === 'push') {
    const ref = String(event.ref);
    const branchFilters = cfg.branches || cfg['branches-ignore'];
    const tagFilters = cfg.tags || cfg['tags-ignore'];
    if (ref.startsWith('refs/heads/')) {
      // Only tag filters: branch pushes do not trigger.
      if (tagFilters && !branchFilters) return false;
      if (!includeIgnore(ref.slice(11), cfg.branches, cfg['branches-ignore'])) return false;
      return pathsMatch(cfg, event.changedFiles);
    }
    if (ref.startsWith('refs/tags/')) {
      if (branchFilters && !tagFilters) return false;
      // Path filters never apply to tag pushes.
      return includeIgnore(ref.slice(10), cfg.tags, cfg['tags-ignore']);
    }
    return false;
  }
  if (event.name === 'pull_request') {
    const types = cfg.types || ['opened', 'synchronize', 'reopened'];
    if (!types.includes(event.action)) return false;
    if (!includeIgnore(String(event.baseBranch), cfg.branches, cfg['branches-ignore'])) return false;
    return pathsMatch(cfg, event.changedFiles);
  }
  return false;
}

// --- matrix -------------------------------------------------------------------------

/**
 * Expand `strategy.matrix` into a list of combinations (each a plain object).
 * Supports axes, `include` and `exclude` with GitHub semantics.
 */
export function expandMatrix(matrix) {
  if (!matrix) return [{}];
  if (!isObj(matrix)) throw new WorkflowError('strategy.matrix must be a mapping');
  const { include, exclude, ...axes } = matrix;
  for (const [k, v] of Object.entries(axes)) {
    if (!Array.isArray(v) || v.length === 0) throw new WorkflowError(`matrix.${k} must be a non-empty list`);
  }
  let combos = [{}];
  for (const [k, values] of Object.entries(axes)) {
    const next = [];
    for (const c of combos) for (const v of values) next.push({ ...c, [k]: v });
    combos = next;
  }
  if (Object.keys(axes).length === 0) combos = [];
  const matches = (combo, partial) =>
    Object.entries(partial).every(([k, v]) => JSON.stringify(combo[k]) === JSON.stringify(v));
  if (exclude !== undefined) {
    if (!Array.isArray(exclude)) throw new WorkflowError('matrix.exclude must be a list');
    combos = combos.filter(c => !exclude.some(x => isObj(x) && matches(c, x)));
  }
  if (include !== undefined) {
    if (!Array.isArray(include)) throw new WorkflowError('matrix.include must be a list');
    const axisKeys = Object.keys(axes);
    const extra = [];
    for (const inc of include) {
      if (!isObj(inc)) continue;
      // GitHub rule: an include extends every original combination whose
      // axis values it does not contradict (added keys may be overwritten,
      // original axis values may not). If it fits none, it is a new job.
      let applied = false;
      for (const c of combos) {
        const fits = Object.entries(inc).every(
          ([k, v]) => !axisKeys.includes(k) || JSON.stringify(c[k]) === JSON.stringify(v),
        );
        if (fits) {
          Object.assign(c, inc);
          applied = true;
        }
      }
      if (!applied) extra.push({ ...inc });
    }
    combos = [...combos, ...extra];
  }
  if (combos.length === 0) combos = [{}];
  if (combos.length > MAX_MATRIX) throw new WorkflowError(`Matrix expands to ${combos.length} jobs (max ${MAX_MATRIX})`);
  return combos;
}

/** Display name for a matrix job: `test (18, ubuntu)`. */
export function matrixJobName(name, combo) {
  const values = Object.values(combo);
  if (values.length === 0) return name;
  return `${name} (${values.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ')})`;
}

// --- cron ---------------------------------------------------------------------------

const CRON_NAMES = {
  month: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  dow: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
};
const CRON_FIELDS = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['dom', 1, 31],
  ['month', 1, 12],
  ['dow', 0, 7],
];

/** Parse a 5-field cron expression into sets (UTC). Throws WorkflowError. */
export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new WorkflowError(`Cron '${expr}' must have 5 fields (minute hour day month weekday)`);
  const out = {};
  CRON_FIELDS.forEach(([field, min, max], idx) => {
    const set = new Set();
    const names = CRON_NAMES[field] || {};
    const val = s => {
      const low = s.toLowerCase();
      if (names[low] !== undefined) return names[low];
      if (!/^\d+$/.test(s)) throw new WorkflowError(`Cron '${expr}': bad value '${s}'`);
      return Number(s);
    };
    for (const piece of parts[idx].split(',')) {
      const [range, stepRaw] = piece.split('/');
      const step = stepRaw === undefined ? 1 : Number(stepRaw);
      if (!(step >= 1) || !Number.isInteger(step)) throw new WorkflowError(`Cron '${expr}': bad step '${stepRaw}'`);
      let lo;
      let hi;
      if (range === '*') [lo, hi] = [min, max];
      else if (range.includes('-')) [lo, hi] = range.split('-').map(val);
      else {
        lo = val(range);
        hi = stepRaw === undefined ? lo : max;
      }
      if (lo < min || hi > max || lo > hi) throw new WorkflowError(`Cron '${expr}': ${field} out of range`);
      for (let v = lo; v <= hi; v += step) set.add(field === 'dow' && v === 7 ? 0 : v);
    }
    out[field] = set;
    out[`${field}Any`] = parts[idx] === '*';
  });
  return out;
}

/** Does `date` (its UTC minute) match the cron expression? */
export function cronMatches(expr, date) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(date);
  if (!c.minute.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours()) || !c.month.has(d.getUTCMonth() + 1)) {
    return false;
  }
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  // Standard cron: when both day fields are restricted, either may match.
  if (!c.domAny && !c.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

// --- expressions ----------------------------------------------------------------------

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '&&', '||', '<=', '>='].includes(two)) {
      tokens.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('!<>()[].,*'.includes(c)) {
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === "'") {
      let s = '';
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") {
          s += "'";
          i += 2;
        } else if (src[i] === "'") break;
        else s += src[i++];
      }
      if (src[i] !== "'") throw new WorkflowError(`Unterminated string in expression '${src}'`);
      i++;
      tokens.push({ t: 'str', v: s });
      continue;
    }
    const num = /^-?(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(src.slice(i));
    if (num && (c === '-' || /\d/.test(c))) {
      tokens.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (id) {
      tokens.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new WorkflowError(`Unexpected '${c}' in expression '${src}'`);
  }
  return tokens;
}

function toNum(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v);
  return NaN;
}

function looseEq(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b) return a === b || (a === null && b === null);
  if (a === null || b === null || typeof a === 'object' || typeof b === 'object') return a === b;
  return toNum(a) === toNum(b);
}

export function truthy(v) {
  if (v === null || v === undefined || v === false || v === '' || v === 0) return false;
  if (typeof v === 'number' && Number.isNaN(v)) return false;
  return true;
}

export function stringify(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function getProp(obj, key) {
  if (obj === null || obj === undefined || typeof obj !== 'object') return null;
  if (Array.isArray(obj) && /^\d+$/.test(String(key))) return obj[Number(key)] ?? null;
  // Context property access is case-insensitive.
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  const lower = String(key).toLowerCase();
  const found = Object.keys(obj).find(k => k.toLowerCase() === lower);
  return found === undefined ? null : obj[found];
}

const FUNCTIONS = {
  contains: (a, b) =>
    Array.isArray(a) ? a.some(x => looseEq(x, b)) : stringify(a).toLowerCase().includes(stringify(b).toLowerCase()),
  startswith: (a, b) => stringify(a).toLowerCase().startsWith(stringify(b).toLowerCase()),
  endswith: (a, b) => stringify(a).toLowerCase().endsWith(stringify(b).toLowerCase()),
  format: (fmt, ...args) =>
    stringify(fmt).replace(/\{\{|\}\}|\{(\d+)\}/g, (m, n) => (m === '{{' ? '{' : m === '}}' ? '}' : stringify(args[Number(n)]))),
  join: (a, sep = ',') => (Array.isArray(a) ? a.map(stringify).join(stringify(sep)) : stringify(a)),
  tojson: v => JSON.stringify(v ?? null, null, 2),
  fromjson: v => {
    try {
      return JSON.parse(stringify(v));
    } catch {
      throw new WorkflowError(`fromJSON: invalid JSON`);
    }
  },
};

/**
 * Evaluate a GitHub Actions expression (the part inside `${{ }}`).
 *
 * @param {string} src
 * @param {object} ctx  contexts: github, env, secrets, inputs, matrix, needs,
 *                      steps, job, runner, vars, plus `status` for the
 *                      status functions: 'success' | 'failure' | 'cancelled'
 */
export function evaluate(src, ctx = {}) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = v => {
    const t = tokens[pos];
    if (!t || t.v !== v) throw new WorkflowError(`Expected '${v}' in expression '${src}'`);
    pos++;
    return t;
  };
  const isOp = v => peek()?.t === 'op' && peek().v === v;

  function primary() {
    const t = tokens[pos++];
    if (!t) throw new WorkflowError(`Unexpected end of expression '${src}'`);
    if (t.t === 'str' || t.t === 'num') return t.v;
    if (t.t === 'op' && t.v === '(') {
      const v = or();
      eat(')');
      return v;
    }
    if (t.t === 'op' && t.v === '!') return !truthy(unary());
    if (t.t === 'id') {
      const lower = t.v.toLowerCase();
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      if (lower === 'null') return null;
      if (isOp('(')) {
        eat('(');
        const args = [];
        if (!isOp(')')) {
          args.push(or());
          while (isOp(',')) {
            eat(',');
            args.push(or());
          }
        }
        eat(')');
        const status = ctx.status || 'success';
        if (lower === 'success') return status === 'success';
        if (lower === 'failure') return status === 'failure';
        if (lower === 'cancelled') return status === 'cancelled';
        if (lower === 'always') return true;
        if (lower === 'hashfiles') return '';
        const fn = FUNCTIONS[lower];
        if (!fn) throw new WorkflowError(`Unknown function '${t.v}' in expression`);
        return fn(...args);
      }
      return getProp(ctx, t.v) ?? getProp(ctx, lower);
    }
    throw new WorkflowError(`Unexpected '${t.v}' in expression '${src}'`);
  }

  function postfix() {
    let v = primary();
    for (;;) {
      if (isOp('.')) {
        eat('.');
        const t = tokens[pos++];
        if (!t) throw new WorkflowError(`Expected a property name in '${src}'`);
        if (t.t === 'op' && t.v === '*') {
          v = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : [];
          continue;
        }
        if (t.t !== 'id' && t.t !== 'num') throw new WorkflowError(`Expected a property name in '${src}'`);
        v = Array.isArray(v) && isObj(v[0]) ? v.map(x => getProp(x, t.v)) : getProp(v, String(t.v));
      } else if (isOp('[')) {
        eat('[');
        const key = or();
        eat(']');
        v = getProp(v, stringify(key));
      } else return v;
    }
  }

  function unary() {
    if (isOp('!')) {
      eat('!');
      return !truthy(unary());
    }
    return postfix();
  }

  function comparison() {
    let left = unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || !['==', '!=', '<', '>', '<=', '>='].includes(t.v)) return left;
      pos++;
      const right = unary();
      if (t.v === '==') left = looseEq(left, right);
      else if (t.v === '!=') left = !looseEq(left, right);
      else {
        const [a, b] =
          typeof left === 'string' && typeof right === 'string'
            ? [left.toLowerCase(), right.toLowerCase()]
            : [toNum(left), toNum(right)];
        left = t.v === '<' ? a < b : t.v === '>' ? a > b : t.v === '<=' ? a <= b : a >= b;
      }
    }
  }

  function and() {
    let left = comparison();
    while (isOp('&&')) {
      eat('&&');
      const right = comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  function or() {
    let left = and();
    while (isOp('||')) {
      eat('||');
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  const result = or();
  if (pos !== tokens.length) throw new WorkflowError(`Unexpected '${tokens[pos].v}' in expression '${src}'`);
  return result;
}

/** Replace every `${{ expr }}` in a string. */
export function interpolate(text, ctx) {
  return String(text).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr) => stringify(evaluate(expr.trim(), ctx)));
}

/**
 * Evaluate an `if:` condition. Without a status function, GitHub implicitly
 * wraps it in `success() && (...)`.
 */
export function evaluateIf(cond, ctx) {
  if (cond === null || cond === undefined || String(cond).trim() === '') return (ctx.status || 'success') === 'success';
  let src = String(cond).trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(src);
  if (wrapped) src = wrapped[1].trim();
  const usesStatus = /\b(success|failure|cancelled|always)\s*\(/i.test(src);
  const value = truthy(evaluate(src, ctx));
  if (usesStatus) return value;
  return (ctx.status || 'success') === 'success' && value;
}

// --- misc -----------------------------------------------------------------------------

/**
 * Parse `$GITHUB_ENV` / `$GITHUB_OUTPUT` file content: `KEY=value` lines and
 * `KEY<<DELIM ... DELIM` blocks.
 */
export function parseKeyValueFile(text) {
  const out = {};
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const heredoc = /^([^=<\s]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const [, key, delim] = heredoc;
      const body = [];
      i++;
      while (i < lines.length && lines[i] !== delim) body.push(lines[i++]);
      out[key] = body.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Image for a job: container.image, a `runs-on` label, or a raw image name. */
export function imageFor(job, { defaultImage, sandboxImage }) {
  if (job.container?.image) return job.container.image;
  const label = String(job.runsOn || '').trim();
  if (!label || /^(ubuntu|linux|self-hosted|nixre)(-latest|-[\d.]+)?$/i.test(label)) return defaultImage;
  if (label === 'nixre-sandbox') return sandboxImage;
  // Anything that looks like an image reference is used as one.
  if (/^[a-z0-9][a-z0-9._/-]*(:[\w.-]+)?(@sha256:[a-f0-9]{64})?$/i.test(label)) return label;
  throw new WorkflowError(`runs-on '${label}' is not a known label or image`);
}
