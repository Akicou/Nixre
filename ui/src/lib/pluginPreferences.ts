// Plugin preference storage - server-backed via nixre-sync.
//
// Two independent layers:
//
//   1. Server/instance gate (available) - the operator has enabled the plugin
//      for the instance. In production this is a deploy-time setting; here it
//      is stored per-admin in the sync backend so the console can manage it.
//      Real enforcement still lives on the server (see README "Plugins").
//   2. User toggle (enabled) - an individual user turns the plugin on. Every
//      plugin is disabled by default.
//
// A plugin is only *live* when BOTH layers allow it.
//
// Source of truth is the nixre-sync service (Postgres). All functions are
// async; components load them on mount. See lib/syncApi.ts.

import * as sync from './syncApi';

const AVAILABLE_KEY = 'plugins_available';
const ENABLED_KEY = 'plugins_enabled';
const CONFIG_KEY = 'plugin_configs';

async function getList(key: string): Promise<string[]> {
  const prefs = await sync.getAllPrefs();
  const value = prefs[key];
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

async function putList(key: string, list: string[]): Promise<void> {
  await sync.putPref(key, list);
}

// --- Server / instance gate -------------------------------------------------

export async function getServerAvailableIds(): Promise<string[]> {
  return getList(AVAILABLE_KEY);
}

export async function setServerAvailableIds(ids: string[]): Promise<void> {
  await putList(AVAILABLE_KEY, ids);
}

/** Toggle a single plugin's server availability. */
export async function setServerAvailablePlugin(id: string, on: boolean): Promise<void> {
  const current = new Set(await getServerAvailableIds());
  if (on) current.add(id);
  else current.delete(id);
  await setServerAvailableIds([...current]);
}

export async function isPluginAvailable(id: string): Promise<boolean> {
  return (await getServerAvailableIds()).includes(id);
}

// --- User toggle ------------------------------------------------------------

export async function getUserEnabledIds(): Promise<string[]> {
  return getList(ENABLED_KEY);
}

export async function setUserEnabledPlugin(id: string, on: boolean): Promise<void> {
  const current = new Set(await getUserEnabledIds());
  if (on) current.add(id);
  else current.delete(id);
  await putList(ENABLED_KEY, [...current]);
}

export async function isPluginEnabled(id: string): Promise<boolean> {
  return (await getUserEnabledIds()).includes(id);
}

// --- Combined ---------------------------------------------------------------

/** A plugin is live only when the server has it available AND the user enabled it. */
export async function isPluginLive(id: string): Promise<boolean> {
  const [available, enabled] = await Promise.all([isPluginAvailable(id), isPluginEnabled(id)]);
  return available && enabled;
}

// --- Generic plugin configuration values ------------------------------------
// Saved key/value settings for plugins that only ship a configuration form.

export async function getPluginConfig(id: string): Promise<Record<string, string | number | boolean>> {
  const prefs = await sync.getAllPrefs();
  const configs = prefs[CONFIG_KEY];
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) return {};
  const entry = (configs as Record<string, unknown>)[id];
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? (entry as Record<string, string | number | boolean>)
    : {};
}

export async function setPluginConfig(id: string, values: Record<string, string | number | boolean>): Promise<void> {
  const prefs = await sync.getAllPrefs();
  const configs =
    prefs[CONFIG_KEY] && typeof prefs[CONFIG_KEY] === 'object' && !Array.isArray(prefs[CONFIG_KEY])
      ? { ...(prefs[CONFIG_KEY] as Record<string, unknown>) }
      : {};
  configs[id] = values;
  await sync.putPref(CONFIG_KEY, configs);
}
