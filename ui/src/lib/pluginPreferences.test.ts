import { describe, it, expect, beforeEach } from 'vitest';
import {
  setServerAvailablePlugin,
  isPluginAvailable,
  getServerAvailableIds,
  setUserEnabledPlugin,
  isPluginEnabled,
  getUserEnabledIds,
  isPluginLive,
  setPluginConfig,
  getPluginConfig,
} from './pluginPreferences';
import { installSyncFetchMock, syncMockReset } from '../test/syncMock';

installSyncFetchMock();

beforeEach(() => {
  localStorage.clear();
  syncMockReset();
});

describe('pluginPreferences (server-backed)', () => {
  it('starts with all plugins off', async () => {
    expect(await getServerAvailableIds()).toEqual([]);
    expect(await getUserEnabledIds()).toEqual([]);
  });

  it('toggles server availability', async () => {
    expect(await isPluginAvailable('ci-cd-pipelines')).toBe(false);
    await setServerAvailablePlugin('ci-cd-pipelines', true);
    expect(await isPluginAvailable('ci-cd-pipelines')).toBe(true);
    expect(await getServerAvailableIds()).toContain('ci-cd-pipelines');
  });

  it('toggles server availability off again', async () => {
    await setServerAvailablePlugin('issues-tracker', true);
    await setServerAvailablePlugin('issues-tracker', false);
    expect(await isPluginAvailable('issues-tracker')).toBe(false);
  });

  it('toggles user enablement', async () => {
    await setUserEnabledPlugin('nixre-assistant', true);
    expect(await isPluginEnabled('nixre-assistant')).toBe(true);
    await setUserEnabledPlugin('nixre-assistant', false);
    expect(await isPluginEnabled('nixre-assistant')).toBe(false);
  });

  it('requires both layers for a plugin to be live', async () => {
    await setServerAvailablePlugin('issues-tracker', true);
    expect(await isPluginLive('issues-tracker')).toBe(false); // available, not enabled

    await setUserEnabledPlugin('issues-tracker', true);
    expect(await isPluginLive('issues-tracker')).toBe(true);

    await setUserEnabledPlugin('issues-tracker', false);
    expect(await isPluginLive('issues-tracker')).toBe(false);
  });

  it('stores plugin configs under their own key', async () => {
    await setPluginConfig('ci-cd-pipelines', { failOnWarnings: true, triggerBranches: 'main' });
    const config = await getPluginConfig('ci-cd-pipelines');
    expect(config.failOnWarnings).toBe(true);
    expect(config.triggerBranches).toBe('main');
    // Other plugins are untouched.
    expect(await getPluginConfig('issues-tracker')).toEqual({});
  });
});
