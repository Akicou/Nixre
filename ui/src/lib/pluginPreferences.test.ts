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
    expect(await isPluginAvailable('nixre-assistant')).toBe(false);
    await setServerAvailablePlugin('nixre-assistant', true);
    expect(await isPluginAvailable('nixre-assistant')).toBe(true);
    expect(await getServerAvailableIds()).toContain('nixre-assistant');
  });

  it('toggles server availability off again', async () => {
    await setServerAvailablePlugin('nixre-assistant', true);
    await setServerAvailablePlugin('nixre-assistant', false);
    expect(await isPluginAvailable('nixre-assistant')).toBe(false);
  });

  it('toggles user enablement', async () => {
    await setUserEnabledPlugin('nixre-assistant', true);
    expect(await isPluginEnabled('nixre-assistant')).toBe(true);
    await setUserEnabledPlugin('nixre-assistant', false);
    expect(await isPluginEnabled('nixre-assistant')).toBe(false);
  });

  it('requires both layers for a plugin to be live', async () => {
    await setServerAvailablePlugin('nixre-assistant', true);
    expect(await isPluginLive('nixre-assistant')).toBe(false); // available, not enabled

    await setUserEnabledPlugin('nixre-assistant', true);
    expect(await isPluginLive('nixre-assistant')).toBe(true);

    await setUserEnabledPlugin('nixre-assistant', false);
    expect(await isPluginLive('nixre-assistant')).toBe(false);
  });

  it('stores plugin configs under their own key', async () => {
    await setPluginConfig('nixre-assistant', { canRunBash: true, allowedPaths: 'src/**' });
    const config = await getPluginConfig('nixre-assistant');
    expect(config.canRunBash).toBe(true);
    expect(config.allowedPaths).toBe('src/**');
    // Other plugins are untouched.
    expect(await getPluginConfig('example-plugin')).toEqual({});
  });
});
