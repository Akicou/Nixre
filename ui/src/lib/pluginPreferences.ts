// Plugin preference storage - mirrors the authLock.ts pattern.
//
// Two independent layers, both persisted in localStorage:
//
//   1. Server/instance gate (available) - the operator has enabled the plugin
//      for the instance. In production this is a deploy-time setting; here it is
//      a client-side mirror so the UI can show what the server would serve.
//      Real enforcement still lives on the server (see README "Plugins").
//   2. User toggle (enabled) - an individual user turns the plugin on. Every
//      plugin is disabled by default.
//
// A plugin is only *live* when BOTH layers allow it. There is no REST endpoint
// (Gitness exposes none) - state stays local until a backend is added.

const SERVER_AVAILABLE_KEY = 'nixre_plugins_available';
const USER_ENABLED_KEY = 'nixre_plugins_enabled';

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x: unknown): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]): void {
  localStorage.setItem(key, JSON.stringify(list));
}

// --- Server / instance gate -------------------------------------------------

export function getServerAvailableIds(): string[] {
  return readList(SERVER_AVAILABLE_KEY);
}

export function setServerAvailableIds(ids: string[]): void {
  writeList(SERVER_AVAILABLE_KEY, ids);
}

/** Toggle a single plugin's server availability. */
export function setServerAvailablePlugin(id: string, on: boolean): void {
  const current = new Set(getServerAvailableIds());
  if (on) current.add(id);
  else current.delete(id);
  setServerAvailableIds([...current]);
}

export function isPluginAvailable(id: string): boolean {
  return getServerAvailableIds().includes(id);
}

// --- User toggle ------------------------------------------------------------

export function getUserEnabledIds(): string[] {
  return readList(USER_ENABLED_KEY);
}

export function setUserEnabledPlugin(id: string, on: boolean): void {
  const current = new Set(getUserEnabledIds());
  if (on) current.add(id);
  else current.delete(id);
  writeList(USER_ENABLED_KEY, [...current]);
}

export function isPluginEnabled(id: string): boolean {
  return getUserEnabledIds().includes(id);
}

// --- Combined ---------------------------------------------------------------

/** A plugin is live only when the server has it available AND the user enabled it. */
export function isPluginLive(id: string): boolean {
  return isPluginAvailable(id) && isPluginEnabled(id);
}

// --- Generic plugin configuration values ------------------------------------
// Saved key/value settings for plugins that only ship a configuration form.

const CONFIG_KEY = 'nixre_plugin_configs';

export function getPluginConfig(id: string): Record<string, string | number | boolean> {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const entry = parsed[id];
    return entry && typeof entry === 'object' ? entry : {};
  } catch {
    return {};
  }
}

export function setPluginConfig(id: string, values: Record<string, string | number | boolean>): void {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {}
  if (!parsed || typeof parsed !== 'object') parsed = {};
  parsed[id] = values;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(parsed));
}
