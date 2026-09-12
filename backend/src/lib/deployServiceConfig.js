import { randomBytes } from 'node:crypto';
import { normalizeRootDir, sanitizeServiceName } from './deployPure.js';
import { normalizeRuntimeOptions } from './deployRuntimeOptions.js';
import { validateExternalGitUrl } from './deployGit.js';

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

export function validateDeployRef(value) {
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value)
    || value.includes('..') || value.includes('//') || value.endsWith('/')
    || value.split('/').some(p => p.startsWith('.') || p.startsWith('-') || p.endsWith('.') || /\.lock$/i.test(p))) {
    invalid('branch/ref must be a Git branch, tag or commit, not a revision expression');
  }
  return value;
}

function path(value, field, absolute = false) {
  if (typeof value !== 'string' || value.length > 500 || !/^[A-Za-z0-9_./-]+$/.test(value)
    || value.startsWith('/') !== absolute || value.split('/').some(p => p === '..' || p.toLowerCase() === '.git' || p.startsWith('-')) || value.includes('//')
    || (absolute && (value === '/' || value.split('/').includes('.')))) invalid(`${field} must be a safe ${absolute ? 'absolute container' : 'relative'} path`);
  const normalized = absolute ? value.replace(/\/$/, '') : normalizeRootDir(value);
  if (field === 'dockerfile_path' && normalized === '.') invalid('dockerfile_path must identify a file');
  return normalized;
}

function number(value, field, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    invalid(`${field} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return value;
}

export function validateServiceEnv(value, { allowNull = false, template = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('env must be an object of KEY -> string' + (allowNull ? '|null' : ''));
  if (Object.keys(value).length > 100) invalid('At most 100 env vars per service');
  for (const [key, v] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) invalid('Invalid env var name');
    if (!(allowNull && v === null) && (typeof v !== 'string' || v.length > 32768 || v.includes('\0'))) invalid(`Env var '${key}' must be a string of at most 32768 characters without NUL`);
    // Initialization values remain server-managed, including after a volume's
    // deployment history is pruned. SQL credential rotation is a separate task.
    if (template === 'postgres' && (key.startsWith('POSTGRES_') || key === 'PGDATA')) invalid('Postgres initialization variables are immutable; use a new service/restore to change initialization settings');
  }
  return value;
}

const FIELDS = new Set(['name', 'source_type', 'git_url', 'image_ref', 'build_target', 'template', 'root_dir', 'dockerfile_path',
  'branch', 'ref', 'auto_deploy', 'container_port', 'cpu_cores', 'memory_mb', 'exposure', 'deployment_strategy', 'volume_path',
  'runtime_options', 'env', 'database', 'username']);
const PATCH_FIELDS = new Set([...FIELDS, 'cpu_nano_cpus', 'memory_bytes', 'preserve_status_min', 'success_retention_hours',
  'failure_retention_hours', 'security_policy_version', 'desired_state']);

export async function validateServiceConfig(body, { service = null, repo = null, admin = false, env = process.env, validateGitUrl } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Service config must be a JSON object');
  const patch = service !== null;
  for (const key of Object.keys(body)) if (!(patch ? PATCH_FIELDS : FIELDS).has(key)) invalid(`Unknown or immutable service field '${key}'`);
  if (patch) {
    for (const key of ['source_type', 'template', 'database', 'username']) if (Object.hasOwn(body, key)) invalid(`${key} is immutable`);
  }
  const source = patch ? (service.source_type || 'repo') : (repo ? 'repo' : body.source_type);
  if (!['repo', 'git', 'image'].includes(source) || (!patch && repo && body.source_type != null && body.source_type !== 'repo')
    || (!patch && !repo && source === 'repo')) invalid('Standalone source_type must be git or image');
  const template = patch ? (service.template ?? null) : (body.template ?? null);
  if (template !== null && (template !== 'postgres' || source !== 'image')) invalid('Only image services support the postgres template');
  for (const key of ['git_url', 'image_ref']) {
    if (Object.hasOwn(body, key) && source !== (key === 'git_url' ? 'git' : 'image')) invalid(`${key} does not apply to this source`);
  }
  if (source === 'image') {
    for (const key of ['branch', 'ref', 'root_dir', 'dockerfile_path', 'build_target']) if (Object.hasOwn(body, key)) invalid(`${key} does not apply to image services`);
  }
  if (template !== 'postgres' && (Object.hasOwn(body, 'database') || Object.hasOwn(body, 'username'))) invalid('database/username require the postgres template');
  if (source !== 'repo' && Object.hasOwn(body, 'auto_deploy') && body.auto_deploy !== false) invalid('Standalone services cannot auto_deploy');
  if (source !== 'repo' && body.deployment_strategy === 'blue_green') invalid('Standalone services require recreate deployment_strategy');

  const out = patch ? {} : {
    source_type: source, template, git_url: null, image_ref: null, build_target: null,
    root_dir: '.', dockerfile_path: 'Dockerfile', branch: repo?.default_branch || 'main',
    auto_deploy: source === 'repo', container_port: 8080, cpu_nano_cpus: 1e9, memory_bytes: 512 * 1024 ** 2,
    exposure: source === 'repo' ? 'http' : 'internal', deployment_strategy: source === 'repo' ? 'blue_green' : 'recreate',
    volume_path: null, runtime_options: null,
  };
  if (!patch || Object.hasOwn(body, 'name')) {
    if (source === 'repo') {
      if (body.name != null && (typeof body.name !== 'string' || body.name.length > 200)) invalid('name is too long or not a string');
      out.name = sanitizeServiceName(body.name || '');
    } else {
      if (typeof body.name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(body.name)) invalid('name must be a lowercase DNS label of at most 40 characters');
      out.name = body.name;
    }
  }
  for (const key of ['root_dir', 'dockerfile_path', 'volume_path']) if (Object.hasOwn(body, key)) {
    out[key] = key === 'volume_path' && body[key] === null ? null : path(body[key], key, key === 'volume_path');
  }
  if (!patch && source === 'git' && !Object.hasOwn(body, 'dockerfile_path')) invalid('External Git services require an explicit dockerfile_path');
  if (!patch && source === 'repo') {
    // Shipped repo creation can inspect a ref different from its auto-deploy branch.
    if (Object.hasOwn(body, 'ref')) validateDeployRef(body.ref);
    if (Object.hasOwn(body, 'branch')) out.branch = validateDeployRef(body.branch);
  } else {
    if (Object.hasOwn(body, 'ref') && Object.hasOwn(body, 'branch') && body.ref !== body.branch) invalid('ref and branch must agree');
    if (Object.hasOwn(body, 'branch') || Object.hasOwn(body, 'ref')) out.branch = validateDeployRef(body.branch ?? body.ref);
  }
  if (Object.hasOwn(body, 'build_target')) {
    if (body.build_target !== null && (typeof body.build_target !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(body.build_target))) invalid('build_target must be a Docker build stage name');
    out.build_target = body.build_target;
  }
  if ((!patch && source === 'git') || Object.hasOwn(body, 'git_url')) {
    try {
      const validate = validateGitUrl || validateExternalGitUrl;
      out.git_url = await validate(body.git_url, env);
    } catch (err) { invalid(err.message); }
  }
  if ((!patch && source === 'image') || Object.hasOwn(body, 'image_ref')) {
    const image = body.image_ref;
    if (typeof image !== 'string' || image.length > 512 || !/^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/.test(image)) invalid('image_ref must be a Docker image reference without credentials or URL syntax');
    out.image_ref = image;
  }
  for (const [key, values] of [['exposure', ['http', 'internal']], ['deployment_strategy', ['blue_green', 'recreate']], ['desired_state', ['running', 'stopped']]]) {
    if (Object.hasOwn(body, key)) {
      if (!values.includes(body[key])) invalid(`${key} must be ${values.join(' or ')}`);
      out[key] = body[key];
    }
  }
  if (Object.hasOwn(body, 'auto_deploy')) {
    if (typeof body.auto_deploy !== 'boolean') invalid('auto_deploy must be a boolean');
    out.auto_deploy = body.auto_deploy;
  }
  for (const [key, min, max] of [['container_port', 1, 65535], ['cpu_nano_cpus', 1e8, 64e9], ['memory_bytes', 32 * 1024 ** 2, 256 * 1024 ** 3],
    ['preserve_status_min', 100, 600], ['success_retention_hours', 0, 8760], ['failure_retention_hours', 0, 8760]]) {
    if (Object.hasOwn(body, key)) out[key] = number(body[key], key, min, max, true);
  }
  if (Object.hasOwn(body, 'cpu_cores')) {
    if (Object.hasOwn(body, 'cpu_nano_cpus')) invalid('Specify cpu_cores or cpu_nano_cpus, not both');
    out.cpu_nano_cpus = Math.round(number(body.cpu_cores, 'cpu_cores', 0.1, 64) * 1e9);
  }
  if (Object.hasOwn(body, 'memory_mb')) {
    if (Object.hasOwn(body, 'memory_bytes')) invalid('Specify memory_mb or memory_bytes, not both');
    out.memory_bytes = number(body.memory_mb, 'memory_mb', 32, 262144, true) * 1024 ** 2;
  }
  if (Object.hasOwn(body, 'security_policy_version')) {
    if (!admin) throw Object.assign(new Error('Only an instance admin can change the deployment security policy'), { status: 403 });
    if (![1, 2].includes(body.security_policy_version)) invalid('security_policy_version must be the number 1 or 2');
    out.security_policy_version = body.security_policy_version;
  }
  if (Object.hasOwn(body, 'runtime_options')) {
    const host = body.runtime_options?.host_config;
    if (host !== undefined && host !== null && (typeof host !== 'object' || Array.isArray(host))) invalid('runtime_options.host_config must be an object');
    try { out.runtime_options = body.runtime_options === null ? null : normalizeRuntimeOptions(body.runtime_options, { admin, env }); }
    catch (err) { invalid(err.message); }
  }
  const vars = Object.hasOwn(body, 'env') ? { ...validateServiceEnv(body.env, { allowNull: patch, template }) } : {};
  if (patch && Object.hasOwn(out, 'volume_path') && out.volume_path !== (service.volume_path ?? null)) invalid('volume_path is immutable; create a new service to change storage');
  const volume = patch ? service.volume_path : out.volume_path;
  if (!patch && volume && !Object.hasOwn(body, 'deployment_strategy')) out.deployment_strategy = 'recreate';
  if (volume && (out.deployment_strategy ?? service?.deployment_strategy) !== 'recreate') invalid('Services with managed storage require recreate deployment_strategy');
  const runtime = Object.hasOwn(out, 'runtime_options') ? out.runtime_options : service?.runtime_options;
  if (source !== 'repo' && runtime?.host_config?.network_mode) invalid('Standalone services must use the shared apps network');
  if (volume && (runtime?.host_config?.binds?.some(b => b.split(':')[1] === volume) || Object.hasOwn(runtime?.host_config?.tmpfs || {}, volume))) invalid('Managed volume conflicts with another runtime mount');
  if (template === 'postgres') {
    if (!patch) {
      if (!['postgres:16', 'postgres:17'].includes(out.image_ref)) invalid('Postgres template supports postgres:16 or postgres:17');
      for (const [key, value] of Object.entries({ volume_path: '/var/lib/postgresql/data', deployment_strategy: 'recreate', exposure: 'internal', container_port: 5432 })) {
        if (Object.hasOwn(body, key) && out[key] !== value) invalid(`Postgres template requires ${key}=${value}`);
        out[key] = value;
      }
      if (body.runtime_options != null) invalid('Postgres template runtime options are managed by the server');
      if (Object.keys(vars).length > 97) invalid('At most 97 custom env vars alongside Postgres initialization variables');
      for (const [key, input] of [['POSTGRES_DB', body.database ?? 'app'], ['POSTGRES_USER', body.username ?? 'app']]) {
        if (typeof input !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(input)) invalid('Postgres database and username must be lowercase SQL identifiers of at most 63 characters');
        vars[key] = input;
      }
      vars.POSTGRES_PASSWORD = randomBytes(32).toString('base64url');
    } else {
      for (const key of ['volume_path', 'deployment_strategy', 'exposure', 'container_port', 'runtime_options', 'security_policy_version']) {
        if (Object.hasOwn(body, key)) invalid(`Postgres template ${key} is immutable`);
      }
      if (Object.hasOwn(body, 'image_ref') && body.image_ref !== service.image_ref) invalid('Postgres image upgrades require a new service and an explicit restore');
    }
  }
  return { config: out, vars };
}
