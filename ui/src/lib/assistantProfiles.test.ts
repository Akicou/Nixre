import { describe, it, expect, beforeEach } from 'vitest';
import {
  defaultProviderProfile,
  defaultRepoProfile,
  getActiveProviderProfile,
  setActiveProviderProfile,
  getRepoProfile,
  setRepoProfile,
  clearRepoProfile,
} from './assistantProfiles';
import { getPlugin } from './plugins';
import { installSyncFetchMock, syncMockReset } from '../test/syncMock';

installSyncFetchMock();

beforeEach(() => {
  localStorage.clear();
  syncMockReset();
});

describe('assistantProfiles (server-backed)', () => {
  it('derives the provider defaults from the registry', () => {
    const def = defaultProviderProfile();
    const providerField = getPlugin('nixre-assistant')!.providerFields![0];
    expect(def.provider).toBe(providerField.default);
  });

  it('stores and reads the active provider profile', async () => {
    await setActiveProviderProfile({ ...defaultProviderProfile(), provider: 'anthropic', model: 'claude-sonnet' });
    const active = await getActiveProviderProfile();
    expect(active.provider).toBe('anthropic');
    expect(active.model).toBe('claude-sonnet');
  });

  it('defaults reasoning off with no reasoning effort', () => {
    const def = defaultProviderProfile();
    expect(def.reasoningLevel).toBe('none');
    expect(def.interleavedReasoning).toBe(false);
  });

  it('round-trips reasoning controls', async () => {
    await setActiveProviderProfile({
      ...defaultProviderProfile(),
      reasoningLevel: 'high',
      interleavedReasoning: true,
    });
    const active = await getActiveProviderProfile();
    expect(active.reasoningLevel).toBe('high');
    expect(active.interleavedReasoning).toBe(true);
  });

  it('stores per-repo access profiles keyed by repo path', async () => {
    expect(await getRepoProfile('acme/website')).toBeUndefined();

    await setRepoProfile('acme/website', { ...defaultRepoProfile(), accessLevel: 'full-agent', canMerge: true });
    const repo = await getRepoProfile('acme/website');
    expect(repo?.accessLevel).toBe('full-agent');
    expect(repo?.canMerge).toBe(true);

    await clearRepoProfile('acme/website');
    expect(await getRepoProfile('acme/website')).toBeUndefined();
  });
});
