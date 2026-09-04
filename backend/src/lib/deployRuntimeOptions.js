// Pure validation + normalization for per-service Docker runtime options.
//
// deploy_services.runtime_options (JSONB) carries optional container runtime
// settings that launchContainer merges into the Docker create payload:
//
//   {
//     version: 1,
//     health_path: "/health",           // release probe path (default "/")
//     health_timeout_ms: 30000,         // optional per-service health budget
//     command: ["…"],                   // container Cmd override
//     entrypoint: ["…"],                // container Entrypoint override
//     host_config: {
//       binds: ["/host:/container:rw"], // host bind mounts
//       privileged: false,
//       cap_add: [], cap_drop: [],
//       devices: ["/dev/kvm:/dev/kvm:rwm"],
//       group_add: [998],              // numeric gids
//       extra_hosts: ["db:10.0.0.5"],
//       shm_size: 268435456,           // bytes
//       tmpfs: {"/run": ""},
//       network_mode: null             // bridge | none | host | container:<name>
//     }
//   }
//
// Everything here stays free of DB / Docker / network dependencies so it is
// trivially unit-testable. The API layer calls normalizeRuntimeOptions() with
// the caller's admin flag + the instance's env policy; the engine calls
// getRuntimeOptions() which NEVER throws (a malformed stored value must not
// brick a deploy — it falls back to legacy behavior).
//
// Security model (fail closed):
//   - bind mounts require an instance allowlist (NIXRE_DEPLOY_BIND_ALLOWLIST)
//     AND an instance admin.
//   - privileged requires NIXRE_DEPLOY_ALLOW_PRIVILEGED=true + admin.
//   - network_mode=host requires NIXRE_DEPLOY_ALLOW_HOST_NETWORK=true + admin.
//   - caps/devices/group_add/extra_hosts/tmpfs/shm_size are admin-only.
//   - unknown keys are rejected, so schema drift can't smuggle unvalidated
//     Docker fields into createContainer.

export const RUNTIME_OPTIONS_VERSION = 1;

const BOOL_TRUE = /^(1|true|yes|on)$/i;

// host_config fields that hand a container host-level powers.
const ADMIN_ONLY_HOST_KEYS = new Set([
  'binds',
  'privileged',
  'cap_add',
  'cap_drop',
  'devices',
  'group_add',
  'extra_hosts',
  'shm_size',
  'tmpfs',
  'network_mode',
]);

const KNOWN_TOP_KEYS = new Set([
  'version',
  'health_path',
  'health_timeout_ms',
  'command',
  'entrypoint',
  'host_config',
]);

const KNOWN_HOST_KEYS = new Set(ADMIN_ONLY_HOST_KEYS);

const MAX_BINDS = 16;
const MAX_DEVICES = 16;
const MAX_EXTRA_HOSTS = 32;
const MAX_TMPFS = 16;
const MAX_CAPS = 64;
const MAX_GROUP_ADD = 16;

// Instance policy from environment — read at request time so compose env
// changes apply on core restart without code changes.
export function runtimeFlagsFromEnv(env = process.env) {
  return {
    bindAllowlist: parseBindAllowlist(env.NIXRE_DEPLOY_BIND_ALLOWLIST),
    allowPrivileged: BOOL_TRUE.test(String(env.NIXRE_DEPLOY_ALLOW_PRIVILEGED || '')),
    allowHostNetwork: BOOL_TRUE.test(String(env.NIXRE_DEPLOY_ALLOW_HOST_NETWORK || '')),
  };
}

// "/a, /var/run/docker.sock, /var/lib/x/" -> ["/a", "/var/run/docker.sock", "/var/lib/x"]
export function parseBindAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => (p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') : p));
}

function assertPathSafe(p, label) {
  if (typeof p !== 'string' || !p.startsWith('/')) {
    throw new Error(`runtime options: ${label} '${p}' must be an absolute path`);
  }
  if (p.includes('..')) {
    throw new Error(`runtime options: ${label} '${p}' may not contain '..'`);
  }
  if (/[\s\0]/.test(p)) {
    throw new Error(`runtime options: ${label} may not contain whitespace`);
  }
}

function hostPathAllowed(host, allowlist) {
  if (!allowlist || allowlist.length === 0) return false;
  return allowlist.some(entry => host === entry || host.startsWith(`${entry}/`));
}

function assertHostBindAllowed(host, allowlist) {
  assertPathSafe(host, 'bind host path');
  if (!allowlist || allowlist.length === 0) {
    throw new Error(
      'runtime options: host bind mounts are disabled on this instance ' +
        '(set NIXRE_DEPLOY_BIND_ALLOWLIST to enable specific host paths)',
    );
  }
  if (!hostPathAllowed(host, allowlist)) {
    throw new Error(
      `runtime options: host path '${host}' is not on the bind allowlist (${allowlist.join(', ')})`,
    );
  }
}

// Strings only, or a single whitespace-separated string. Returns [] for
// null/undefined, and the parsed array otherwise.
function asStringArray(value, field, { max = MAX_CAPS, maxLen = 2000 } = {}) {
  if (value == null) return [];
  let list = value;
  if (typeof list === 'string') list = list.trim() === '' ? [] : list.trim().split(/\s+/);
  if (!Array.isArray(list)) {
    throw new Error(`runtime options: ${field} must be an array of strings`);
  }
  if (list.length > max) throw new Error(`runtime options: at most ${max} entries in ${field}`);
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxLen) {
      throw new Error(
        `runtime options: ${field} entries must be non-empty strings (<= ${maxLen} chars)`,
      );
    }
    out.push(item);
  }
  return out;
}

function normalizeBind(spec, allowlist) {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new Error('runtime options: bind entries must be non-empty strings');
  }
  const parts = String(spec).trim().split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `runtime options: bind '${spec}' must look like /host/path:/container/path[:ro|rw|z]`,
    );
  }
  const [host, container, mode] = parts;
  assertHostBindAllowed(host, allowlist);
  assertPathSafe(container, 'bind container path');
  let normalized = `${host}:${container}`;
  if (mode !== undefined) {
    const tokens = String(mode).split(',').map(t => t.trim()).filter(Boolean);
    for (const t of tokens) {
      if (!['ro', 'rw', 'z'].includes(t)) {
        throw new Error(`runtime options: bind mode '${mode}' may only use ro, rw and z`);
      }
    }
    normalized += `:${tokens.join(',')}`;
  }
  return normalized;
}

function normalizeCaps(list, field) {
  const out = [];
  for (const item of list) {
    if (!/^[a-zA-Z0-9_]+$/.test(item)) {
      throw new Error(`runtime options: invalid capability '${item}' in ${field}`);
    }
    out.push(item.toUpperCase());
  }
  return out;
}

function normalizeDevices(list) {
  const out = [];
  for (const item of list) {
    const parts = String(item).split(':');
    if (parts.length < 1 || parts.length > 3) {
      throw new Error(
        `runtime options: device '${item}' must look like /host/dev[:/container/dev][:rwm]`,
      );
    }
    assertPathSafe(parts[0], 'device path');
    const container = parts[1] || parts[0];
    assertPathSafe(container, 'device container path');
    const mode = parts[2] || 'rwm';
    if (!/^[rwm]{1,3}$/.test(mode)) {
      throw new Error(`runtime options: device mode '${mode}' may only use r, w, m`);
    }
    out.push(`${parts[0]}:${container}:${mode}`);
  }
  return out;
}

function normalizeGroupAdd(value) {
  if (value == null) return [];
  const list = Array.isArray(value)
    ? value
    : String(value)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
  if (list.length > MAX_GROUP_ADD) {
    throw new Error(`runtime options: at most ${MAX_GROUP_ADD} entries in host_config.group_add`);
  }
  const out = [];
  for (const item of list) {
    const n = Number(item);
    if (!Number.isInteger(n) || n < 0 || n > 4_294_967_294) {
      throw new Error(`runtime options: group_add entries must be numeric gids, got '${item}'`);
    }
    out.push(n);
  }
  return out;
}

function normalizeExtraHosts(list) {
  const hostRe = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
  const out = [];
  for (const item of list) {
    const idx = String(item).lastIndexOf(':');
    if (idx <= 0) throw new Error(`runtime options: extra host '${item}' must be host:ip`);
    const host = String(item).slice(0, idx);
    const ip = String(item).slice(idx + 1);
    if (!hostRe.test(host)) {
      throw new Error(`runtime options: invalid extra-host name '${host}'`);
    }
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && !ip.includes(':')) {
      throw new Error(`runtime options: invalid extra-host IP '${ip}'`);
    }
    out.push(`${host}:${ip}`);
  }
  return out;
}

function normalizeTmpfs(obj) {
  if (obj == null) return {};
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('runtime options: tmpfs must be an object of /container/path -> options');
  }
  const keys = Object.keys(obj);
  if (keys.length > MAX_TMPFS) {
    throw new Error(`runtime options: at most ${MAX_TMPFS} tmpfs mounts`);
  }
  const out = {};
  for (const k of keys) {
    assertPathSafe(k, 'tmpfs path');
    const v = obj[k];
    if (v != null && typeof v !== 'string') {
      throw new Error('runtime options: tmpfs values must be strings');
    }
    out[k] = v || '';
  }
  return out;
}

function normalizeNetworkMode(value, flags) {
  if (value == null) return null;
  const v = String(value).trim();
  if (v === '') return null;
  if (!['bridge', 'none', 'host'].includes(v) && !/^container:[a-zA-Z0-9_.-]+$/.test(v)) {
    throw new Error(
      "runtime options: network_mode must be 'bridge', 'none', 'host' or 'container:<name>'",
    );
  }
  if (v === 'host' && (!flags.admin || !flags.allowHostNetwork)) {
    throw new Error(
      "runtime options: network_mode 'host' requires an instance admin and " +
        'NIXRE_DEPLOY_ALLOW_HOST_NETWORK=true',
    );
  }
  return v;
}

function normalizeShmSize(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 8 * 1024 ** 3) {
    throw new Error('runtime options: shm_size must be an integer byte count (0 .. 8 GiB)');
  }
  return n;
}

function normalizeStringListField(value, field) {
  if (value == null) return null;
  const out = asStringArray(value, field);
  return out.length === 0 ? null : out;
}

// Main entry: validate + normalize a runtime options object. Throws an Error
// with an operator-friendly message on any violation. ctx may carry:
//   admin            — is the caller an instance admin?
//   env              — env object for policy flags (default process.env)
//   bindAllowlist / allowPrivileged / allowHostNetwork — explicit overrides
//                      (used by tests; otherwise derived from env)
export function normalizeRuntimeOptions(input, ctx = {}) {
  const flags = { admin: Boolean(ctx.admin), ...runtimeFlagsFromEnv(ctx.env) };
  if (ctx.bindAllowlist !== undefined) flags.bindAllowlist = parseBindAllowlist(ctx.bindAllowlist);
  if (ctx.allowPrivileged !== undefined) flags.allowPrivileged = Boolean(ctx.allowPrivileged);
  if (ctx.allowHostNetwork !== undefined) flags.allowHostNetwork = Boolean(ctx.allowHostNetwork);

  const src = input == null ? {} : input;
  if (typeof src !== 'object' || Array.isArray(src)) {
    throw new Error('runtime options must be a JSON object');
  }

  const hostRaw =
    src.host_config && typeof src.host_config === 'object' && !Array.isArray(src.host_config)
      ? src.host_config
      : {};

  // Unknown keys are rejected so schema drift can't smuggle unvalidated Docker
  // fields into createContainer.
  for (const key of Object.keys(src)) {
    if (!KNOWN_TOP_KEYS.has(key)) throw new Error(`runtime options: unknown field '${key}'`);
  }
  for (const key of Object.keys(hostRaw)) {
    if (!KNOWN_HOST_KEYS.has(key)) {
      throw new Error(`runtime options: unknown field 'host_config.${key}'`);
    }
  }
  if (src.version != null && src.version !== RUNTIME_OPTIONS_VERSION) {
    throw new Error(`runtime options: unsupported version ${src.version}`);
  }

  // Admin gate — any explicitly-set host_config field requires instance admin.
  const dangerous = Object.keys(hostRaw).filter(k => ADMIN_ONLY_HOST_KEYS.has(k));
  if (dangerous.length > 0 && !flags.admin) {
    throw new Error(
      `runtime options: host_config.${dangerous.join(', host_config.')} require instance admin rights`,
    );
  }

  // --- health check ---------------------------------------------------------
  let healthPath = src.health_path == null ? '/' : String(src.health_path);
  if (!healthPath.startsWith('/') || healthPath.length > 200 || /\s/.test(healthPath)) {
    throw new Error('runtime options: health_path must start with "/" and be <= 200 chars');
  }
  let healthTimeout = null;
  if (src.health_timeout_ms != null) {
    const n = Number(src.health_timeout_ms);
    if (!Number.isInteger(n) || n < 1_000 || n > 600_000) {
      throw new Error('runtime options: health_timeout_ms must be between 1000 and 600000 ms');
    }
    healthTimeout = n;
  }

  // --- command / entrypoint -------------------------------------------------
  const command = normalizeStringListField(src.command, 'command');
  const entrypoint = normalizeStringListField(src.entrypoint, 'entrypoint');

  // --- host_config ----------------------------------------------------------
  const binds = [];
  for (const b of asStringArray(hostRaw.binds, 'host_config.binds', { max: MAX_BINDS, maxLen: 500 })) {
    binds.push(normalizeBind(b, flags.bindAllowlist));
  }

  let privileged = false;
  if (hostRaw.privileged != null) {
    privileged = Boolean(hostRaw.privileged);
    if (privileged && (!flags.admin || !flags.allowPrivileged)) {
      throw new Error(
        'runtime options: privileged mode requires an instance admin and ' +
          'NIXRE_DEPLOY_ALLOW_PRIVILEGED=true',
      );
    }
  }

  const capAdd = normalizeCaps(
    asStringArray(hostRaw.cap_add, 'host_config.cap_add'),
    'cap_add',
  );
  const capDrop = normalizeCaps(
    asStringArray(hostRaw.cap_drop, 'host_config.cap_drop'),
    'cap_drop',
  );
  const devices = normalizeDevices(
    asStringArray(hostRaw.devices, 'host_config.devices', { max: MAX_DEVICES, maxLen: 500 }),
  );
  const groupAdd = normalizeGroupAdd(hostRaw.group_add);
  const extraHosts = normalizeExtraHosts(
    asStringArray(hostRaw.extra_hosts, 'host_config.extra_hosts', { max: MAX_EXTRA_HOSTS }),
  );
  const shmSize = normalizeShmSize(hostRaw.shm_size);
  const tmpfs = normalizeTmpfs(hostRaw.tmpfs);
  const networkMode = normalizeNetworkMode(hostRaw.network_mode, flags);

  return {
    version: RUNTIME_OPTIONS_VERSION,
    health_path: healthPath,
    health_timeout_ms: healthTimeout,
    command,
    entrypoint,
    host_config: {
      binds,
      privileged,
      cap_add: capAdd,
      cap_drop: capDrop,
      devices,
      group_add: groupAdd,
      extra_hosts: extraHosts,
      shm_size: shmSize,
      tmpfs,
      network_mode: networkMode,
    },
  };
}

// Defensive reader for the engine: accepts a parsed JSONB object or a JSON
// string; never throws (falls back to legacy behavior on garbage).
export function getRuntimeOptions(serviceRow) {
  const raw = serviceRow?.runtime_options;
  if (raw == null) return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const host =
    parsed.host_config && typeof parsed.host_config === 'object' ? parsed.host_config : {};
  return {
    version: parsed.version ?? 1,
    health_path:
      typeof parsed.health_path === 'string' && parsed.health_path.startsWith('/')
        ? parsed.health_path
        : '/',
    health_timeout_ms: Number.isInteger(parsed.health_timeout_ms) ? parsed.health_timeout_ms : null,
    command: Array.isArray(parsed.command) ? parsed.command : null,
    entrypoint: Array.isArray(parsed.entrypoint) ? parsed.entrypoint : null,
    host_config: {
      binds: Array.isArray(host.binds) ? host.binds : [],
      privileged: Boolean(host.privileged),
      cap_add: Array.isArray(host.cap_add) ? host.cap_add : [],
      cap_drop: Array.isArray(host.cap_drop) ? host.cap_drop : [],
      devices: Array.isArray(host.devices) ? host.devices : [],
      group_add: Array.isArray(host.group_add) ? host.group_add : [],
      extra_hosts: Array.isArray(host.extra_hosts) ? host.extra_hosts : [],
      shm_size: Number.isInteger(host.shm_size) ? host.shm_size : null,
      tmpfs: host.tmpfs && typeof host.tmpfs === 'object' && !Array.isArray(host.tmpfs) ? host.tmpfs : {},
      network_mode: typeof host.network_mode === 'string' ? host.network_mode : null,
    },
  };
}
