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

beforeEach(() => localStorage.clear());

describe('pluginPreferences', () => {
  it('defaults everything off', () => {
    expect(getServerAvailableIds()).toEqual([]);
    expect(getUserEnabledIds()).toEqual([]);
  });

  it('toggles server availability per plugin', () => {
    expect(isPluginAvailable('ci-cd-pipelines')).toBe(false);
    setServerAvailablePlugin('ci-cd-pipelines', true);
    expect(isPluginAvailable('ci-cd-pipelines')).toBe(true);
    expect(getServerAvailableIds()).toContain('ci-cd-pipelines');
  });

  it('removes a plugin from the server allowlist when switched off', () => {
    setServerAvailablePlugin('issues-tracker', true);
    setServerAvailablePlugin('issues-tracker', false);
    expect(isPluginAvailable('issues-tracker')).toBe(false);
  });

  it('toggles user enablement per plugin', () => {
    setUserEnabledPlugin('nixre-assistant', true);
    expect(isPluginEnabled('nixre-assistant')).toBe(true);
    setUserEnabledPlugin('nixre-assistant', false);
    expect(isPluginEnabled('nixre-assistant')).toBe(false);
  });

  it('is live only when both the server gate and the user toggle allow it', () => {
    setServerAvailablePlugin('issues-tracker', true);
    expect(isPluginLive('issues-tracker')).toBe(false); // available, not enabled

    setUserEnabledPlugin('issues-tracker', true);
    expect(isPluginLive('issues-tracker')).toBe(true);

    setUserEnabledPlugin('issues-tracker', false);
    expect(isPluginLive('issues-tracker')).toBe(false);
  });

  it('stores and reads generic plugin config values', () => {
    setPluginConfig('ci-cd-pipelines', { failOnWarnings: true, triggerBranches: 'main' });
    const config = getPluginConfig('ci-cd-pipelines');
    expect(config.failOnWarnings).toBe(true);
    expect(config.triggerBranches).toBe('main');
  });
});
