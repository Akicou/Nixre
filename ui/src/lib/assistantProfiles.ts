// Nixre Assistant profile storage - server-backed via nixre-sync.
//
// Two things live here:
//   * The active *provider* profile - which AI provider / model / credentials
//     drive the assistant ("the active AI-provider profile").
//   * Per-repository *access* profiles - what the assistant may do in each repo
//     (access level, tool toggles, merge gate, auto-fix, path allow/block lists).
//
// Defaults are derived from the plugin registry so there is one source of truth.
// Persisted in the nixre-sync backend (Postgres) under the `assistant_profiles`
// pref key - the server is the single source of truth, so profiles follow the
// account across browsers and devices.

import { getPlugin } from './plugins';
import * as sync from './syncApi';

const PREF_KEY = 'assistant_profiles';

const assistant = getPlugin('nixre-assistant');

export interface AssistantProviderProfile {
  provider: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  // Reasoning controls (see plugins.ts providerFields).
  reasoningLevel: string; // none | low | medium | high
  interleavedReasoning: boolean; // stream the model's thinking inline
}

export interface AssistantRepoProfile {
  accessLevel: string;
  canEditFiles: boolean;
  canRunBash: boolean;
  canRunTests: boolean;
  canSearchWeb: boolean;
  canPush: boolean;
  canMerge: boolean;
  autoMergeBranch: string;
  autoMergeOnGreen: boolean;
  autoFixBugs: boolean;
  allowedPaths: string;
  blockedPaths: string;
}

interface StoredProfiles {
  provider: AssistantProviderProfile;
  repoProfiles: Record<string, AssistantRepoProfile>;
}

function defaultsFromFields(fields: { key: string; default: string | number | boolean }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.key] = f.default;
  return out;
}

export function defaultProviderProfile(): AssistantProviderProfile {
  return defaultsFromFields(assistant?.providerFields ?? []) as unknown as AssistantProviderProfile;
}

export function defaultRepoProfile(): AssistantRepoProfile {
  return defaultsFromFields(assistant?.accessFields ?? []) as unknown as AssistantRepoProfile;
}

async function load(): Promise<StoredProfiles> {
  const prefs = await sync.getAllPrefs();
  const parsed = prefs[PREF_KEY];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { provider: defaultProviderProfile(), repoProfiles: {} };
  }
  const p = parsed as Partial<StoredProfiles>;
  return {
    provider: { ...defaultProviderProfile(), ...(p.provider ?? {}) },
    repoProfiles:
      p.repoProfiles && typeof p.repoProfiles === 'object' && !Array.isArray(p.repoProfiles)
        ? p.repoProfiles
        : {},
  };
}

async function save(data: StoredProfiles): Promise<void> {
  await sync.putPref(PREF_KEY, data);
}

export async function getActiveProviderProfile(): Promise<AssistantProviderProfile> {
  return (await load()).provider;
}

export async function setActiveProviderProfile(profile: AssistantProviderProfile): Promise<void> {
  const data = await load();
  data.provider = profile;
  await save(data);
}

export async function getRepoProfile(repoPath: string): Promise<AssistantRepoProfile | undefined> {
  return (await load()).repoProfiles[repoPath];
}

export async function setRepoProfile(repoPath: string, profile: AssistantRepoProfile): Promise<void> {
  const data = await load();
  data.repoProfiles[repoPath] = profile;
  await save(data);
}

export async function clearRepoProfile(repoPath: string): Promise<void> {
  const data = await load();
  delete data.repoProfiles[repoPath];
  await save(data);
}
