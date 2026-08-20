// Nixre Assistant profile storage.
//
// Two things live here:
//   * The active *provider* profile - which AI provider / model / credentials
//     drive the assistant ("the active profile is for the AI provider").
//   * Per-repository *access* profiles - what the assistant may do in each repo
//     (access level, tool toggles, merge gate, auto-fix, path allow/block lists).
//
// Defaults are derived from the plugin registry so there is one source of truth.
// State stays in localStorage (Gitness exposes no such API).

import { getPlugin } from './plugins';

const KEY = 'nixre_assistant_profiles';

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

function load(): StoredProfiles {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      return { provider: defaultProviderProfile(), repoProfiles: {} };
    }
    const parsed = JSON.parse(raw);
    return {
      provider: { ...defaultProviderProfile(), ...(parsed.provider ?? {}) },
      repoProfiles: parsed.repoProfiles && typeof parsed.repoProfiles === 'object' ? parsed.repoProfiles : {},
    };
  } catch {
    return { provider: defaultProviderProfile(), repoProfiles: {} };
  }
}

function save(data: StoredProfiles): void {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function getActiveProviderProfile(): AssistantProviderProfile {
  return load().provider;
}

export function setActiveProviderProfile(profile: AssistantProviderProfile): void {
  const data = load();
  data.provider = profile;
  save(data);
}

export function getRepoProfile(repoPath: string): AssistantRepoProfile | undefined {
  return load().repoProfiles[repoPath];
}

export function setRepoProfile(repoPath: string, profile: AssistantRepoProfile): void {
  const data = load();
  data.repoProfiles[repoPath] = profile;
  save(data);
}

export function clearRepoProfile(repoPath: string): void {
  const data = load();
  delete data.repoProfiles[repoPath];
  save(data);
}
