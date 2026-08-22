// Nixre Assistant profile storage.
//
// Two things live here:
//   * The active *provider* profile - which AI provider / model drives the
//     assistant. Lives server-side in nixre-core (/ai endpoints): the API
//     key is encrypted at rest and never sent to the browser. This module
//     is a thin typed view over lib/aiApi.ts.
//   * Per-repository *access* profiles - what the assistant may do in each
//     repo. Stored with the rest of the account state (sync prefs).
//
// Defaults are derived from the plugin registry so there is one source of
// truth for labels and initial values.

import { getPlugin } from './plugins';
import * as sync from './syncApi';
import { getAiProfile, saveAiProfile, listAiModels, type AiProfile } from './aiApi';

const assistant = getPlugin('nixre-assistant');

export interface AssistantProviderProfile {
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  // Reasoning controls (see plugins.ts providerFields).
  reasoningLevel: string; // none | low | medium | high
  interleavedReasoning: boolean; // stream the model's thinking inline
  // Server-side key state (the key itself never reaches the browser).
  keyConfigured: boolean;
  keyMask: string | null;
  validatedAt: number | null;
  // Live model list fetched from the provider (cached server-side).
  models: string[];
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
  repoProfiles: Record<string, AssistantRepoProfile>;
}

function defaultsFromFields(fields: { key: string; default: string | number | boolean }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.key] = f.default;
  return out;
}

export function defaultProviderProfile(): AssistantProviderProfile {
  const d = defaultsFromFields(assistant?.providerFields ?? []) as Record<string, unknown>;
  return {
    provider: String(d.provider ?? 'deepseek'),
    baseUrl: String(d.baseUrl ?? ''),
    model: String(d.model ?? ''),
    temperature: Number(d.temperature ?? 0.2),
    maxTokens: Number(d.maxTokens ?? 8192),
    reasoningLevel: String(d.reasoningLevel ?? 'none'),
    interleavedReasoning: Boolean(d.interleavedReasoning ?? false),
    keyConfigured: false,
    keyMask: null,
    validatedAt: null,
    models: [],
  };
}

export function defaultRepoProfile(): AssistantRepoProfile {
  return defaultsFromFields(assistant?.accessFields ?? []) as unknown as AssistantRepoProfile;
}

// --- provider profile (server-side via /ai) ---------------------------------

function fromAiProfile(p: AiProfile): AssistantProviderProfile {
  const def = defaultProviderProfile();
  return {
    provider: p.provider,
    baseUrl: p.baseUrl,
    // Model = the active provider's default; models = the enabled subset
    // the user picked for chat (falls back to the provider's full list).
    model: p.model || '',
    temperature: def.temperature,
    maxTokens: def.maxTokens,
    reasoningLevel: p.reasoningLevel,
    interleavedReasoning: p.interleavedReasoning,
    keyConfigured: p.keyConfigured,
    keyMask: p.keyMask,
    validatedAt: p.validatedAt,
    models: p.models ?? [],
  };
}

export async function getActiveProviderProfile(): Promise<AssistantProviderProfile> {
  try {
    return fromAiProfile(await getAiProfile());
  } catch {
    return defaultProviderProfile();
  }
}

/** True when a validated provider is configured and real chat can run. */
export function isRealAi(profile: AssistantProviderProfile): boolean {
  return profile.keyConfigured && profile.validatedAt != null;
}

export async function setActiveProviderProfile(
  profile: AssistantProviderProfile,
  apiKey?: string,
): Promise<AssistantProviderProfile & { validated: boolean }> {
  const saved = await saveAiProfile({
    provider: profile.provider,
    baseUrl: profile.baseUrl || undefined,
    apiKey,
    model: profile.model,
    reasoningLevel: profile.reasoningLevel,
    interleavedReasoning: profile.interleavedReasoning,
  });
  return { ...fromAiProfile(saved), validated: saved.validated };
}

export async function refreshProviderModels(): Promise<string[]> {
  const r = await listAiModels();
  return r.models;
}

// --- per-repo access profiles (sync prefs) ------------------------------------

const PREF_KEY = 'assistant_profiles';

async function load(): Promise<StoredProfiles> {
  const prefs = await sync.getAllPrefs();
  const parsed = prefs[PREF_KEY];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { repoProfiles: {} };
  }
  const repoProfiles =
    (parsed as any).repoProfiles &&
    typeof (parsed as any).repoProfiles === 'object' &&
    !Array.isArray((parsed as any).repoProfiles)
      ? (parsed as any).repoProfiles
      : {};
  return { repoProfiles };
}

async function save(data: StoredProfiles): Promise<void> {
  const prefs = await sync.getAllPrefs();
  await sync.putPref(PREF_KEY, { ...(prefs[PREF_KEY] as object | undefined), repoProfiles: data.repoProfiles });
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
