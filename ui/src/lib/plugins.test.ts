import { describe, it, expect } from 'vitest';
import {
  PLUGINS,
  PLUGIN_COUNT,
  getPlugin,
  fieldsFor,
  isAssistantPlugin,
} from './plugins';

describe('plugin registry', () => {
  it('bundles exactly the plugins that ship a real backend', () => {
    expect(PLUGINS.length).toBe(1);
    expect(PLUGIN_COUNT).toBe(1);
    expect(PLUGINS[0].id).toBe('nixre-assistant');
  });

  it('gives the Nixre Assistant exactly the tool set the backend implements', () => {
    const assistant = getPlugin('nixre-assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.tools?.map(t => t.name)).toEqual([
      'list_files',
      'read_file',
      'search_code',
      'run_command',
      'show_images',
      'web_search',
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

  it('exposes only access toggles the backend enforces', () => {
    const assistant = getPlugin('nixre-assistant')!;
    const keys = (assistant.accessFields ?? []).map(f => f.key);
    expect(keys).toEqual(['canRunBash', 'canRunTests', 'canSearchWeb', 'allowedPaths', 'blockedPaths']);
    // No dead toggles: nothing that claims edits, pushes, merges or auto-fixes.
    for (const dead of ['accessLevel', 'canEditFiles', 'canPush', 'canMerge', 'autoMergeBranch', 'autoMergeOnGreen', 'autoFixBugs']) {
      expect(keys).not.toContain(dead);
    }
  });

  it('keeps the assistant as the only repo-scoped profile plugin', () => {
    const repoScoped = PLUGINS.filter(p => p.repoScoped);
    expect(repoScoped.map(p => p.id)).toEqual(['nixre-assistant']);
  });
});
