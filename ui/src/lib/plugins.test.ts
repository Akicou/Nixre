import { describe, it, expect } from 'vitest';
import {
  PLUGINS,
  PLUGIN_COUNT,
  getPlugin,
  fieldsFor,
  isAssistantPlugin,
} from './plugins';

describe('plugin registry', () => {
  it('bundles 7 plugins: the assistant plus 6 invented ones', () => {
    expect(PLUGINS.length).toBe(7);
    expect(PLUGIN_COUNT).toBe(7);
  });

  it('gives the Nixre Assistant exactly the documented tool set', () => {
    const assistant = getPlugin('nixre-assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.tools?.map(t => t.name)).toEqual([
      'file_read',
      'file_write',
      'bash',
      'run_tests',
      'web_search',
      'git',
    ]);
    expect(isAssistantPlugin(assistant!)).toBe(true);
  });

  it('ships every plugin disabled by default at both activation layers', () => {
    for (const plugin of PLUGINS) {
      expect(plugin.enabledByDefault).toBe(false);
      expect(plugin.availableByDefault).toBe(false);
    }
  });

  it('gives the assistant provider + access profile fields', () => {
    const assistant = getPlugin('nixre-assistant');
    expect(assistant?.providerFields?.length).toBeGreaterThan(0);
    expect(assistant?.accessFields?.length).toBeGreaterThan(0);
    expect(fieldsFor(assistant!)).toEqual([
      ...(assistant!.providerFields ?? []),
      ...(assistant!.accessFields ?? []),
    ]);
  });

  it('frees the model picker from hardcoded lists and adds reasoning controls', () => {
    const assistant = getPlugin('nixre-assistant')!;
    const modelField = assistant.providerFields!.find(f => f.key === 'model');
    expect(modelField?.type).toBe('select');
    // Models are fetched live from the provider (server-side), so the field
    // ships no hardcoded per-provider lists anymore.
    expect(modelField?.modelsByProvider).toBeUndefined();
    expect((modelField?.options ?? []).length).toBe(0);

    const providerField = assistant.providerFields!.find(f => f.key === 'provider');
    expect(providerField?.options).not.toContain('github-copilot');

    const reasoningLevel = assistant.providerFields!.find(f => f.key === 'reasoningLevel');
    const interleaved = assistant.providerFields!.find(f => f.key === 'interleavedReasoning');
    expect(reasoningLevel?.options).toEqual(['none', 'low', 'medium', 'high']);
    expect(interleaved?.type).toBe('toggle');
  });

  it('gives form plugins a profile-fields schema', () => {
    const ci = getPlugin('ci-cd-pipelines');
    expect(ci?.hasForm).toBe(true);
    expect(ci?.profileFields?.length).toBeGreaterThan(0);
    expect(fieldsFor(ci!)).toEqual(ci?.profileFields);
  });

  it('keeps the assistant as the only repo-scoped profile plugin', () => {
    const repoScoped = PLUGINS.filter(p => p.repoScoped);
    expect(repoScoped.map(p => p.id)).toEqual(['nixre-assistant']);
  });
});
