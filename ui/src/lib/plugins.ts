// Nixre plugin registry.
//
// Plugins are "baked into" this repo: every plugin below ships with the Nixre
// build. That is only half the story though. A plugin is actually *live* only
// when TWO gates line up:
//
//   1. Server/instance gate  - the operator has enabled the plugin for the
//      instance. This is a deploy-time setting (see README "Plugins") and is
//      mirrored client-side in pluginPreferences.ts. If the server has not
//      enabled a plugin, it never appears in the UI at all.
//   2. User toggle           - an individual user turns the plugin on. Every
//      plugin is disabled by default (enabledByDefault = false).
//
// A plugin is only listed here if it ships a real backend path: its UI writes
// to nixre-core and the server enforces it. There are no prefs-only stubs.

import {
  Bot,
  LucideIcon,
} from 'lucide-react';

export type ProfileFieldType =
  | 'text'
  | 'secret'
  | 'select'
  | 'toggle'
  | 'range'
  | 'number'
  | 'textarea';

export interface ProfileField {
  key: string;
  label: string;
  description?: string;
  type: ProfileFieldType;
  // Options for `select`.
  options?: string[];
  // When set, a `select` renders provider-scoped options: only the models for
  // the currently-selected provider are shown (used by the assistant model picker).
  modelsByProvider?: Record<string, string[]>;
  // Bounds for `range` / `number`.
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  default: string | number | boolean;
}

export interface PluginTool {
  name: string;
  description: string;
}

export interface Plugin {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  category: string;
  tags: string[];
  // Per-user default. Every plugin is off by default per the spec.
  enabledByDefault: boolean;
  // Server-gate default. All bundled plugins ship disabled at the instance too,
  // so an operator must explicitly opt in.
  availableByDefault: boolean;
  // Whether the plugin ships a generic key/value configuration form.
  hasForm: boolean;
  // Whether the plugin ships structured profiles. `repoScoped` profiles are
  // stored per-repository (e.g. the Assistant's per-repo access profile);
  // non-repo profiles are stored globally.
  hasProfile: boolean;
  repoScoped?: boolean;
  // Assistant-style capability tools.
  tools?: PluginTool[];
  // Provider profile fields (which AI provider/model/credentials to use).
  providerFields?: ProfileField[];
  // Repository access / automation fields (what the plugin may do in a repo).
  accessFields?: ProfileField[];
  // Generic form fields for plugins that only need a settings form.
  profileFields?: ProfileField[];
}

// ---------------------------------------------------------------------------
// Nixre Assistant - AI copilot for agentic engineering work.
//
// The tool set below is exactly what nixre-core's /ai/tools endpoint
// implements (backend/src/lib/agentTools.js). Read tools work against the
// bare repo on disk; run_command runs in a per-conversation Docker sandbox
// (persistent shell + volume) when available, otherwise a fresh clone;
// web_search queries the web. The active profile selects the AI
// provider; per-repo profiles control what it may do.
// ---------------------------------------------------------------------------

const assistantTools: PluginTool[] = [
  { name: 'list_files', description: 'List all file paths in the repository (default branch).' },
  { name: 'read_file', description: 'Read a file from the repository. Paths pointing to images are read analytically (multimodal).' },
  { name: 'search_code', description: 'Regex search across all tracked files. Returns matching lines as path:line: text.' },
  { name: 'run_command', description: 'Run a shell command in the agent sandbox (persistent per conversation) or a fresh clone. Use write_file to create/overwrite files — not cat >.' },
  { name: 'write_file', description: 'Create or overwrite a text file in the agent workspace. Use instead of cat > or heredocs.' },
  { name: 'show_images', description: 'Display one or more images from the repository inline in the chat.' },
  { name: 'web_search', description: 'Search the web for up-to-date docs, APIs and fixes.' },
  { name: 'read_skill', description: 'Load a repository SKILL.md when the task matches its description.' },
];

const providerFields: ProfileField[] = [
  {
    key: 'provider',
    label: 'AI Provider',
    description: 'The active profile selects which AI provider drives the assistant.',
    type: 'select',
    options: ['deepseek', 'openai', 'anthropic', 'ollama', 'custom'],
    default: 'deepseek',
  },
  {
    key: 'apiKey',
    label: 'API Key',
    type: 'secret',
    placeholder: 'sk-… (validated against the provider when saved)',
    default: '',
  },
  {
    key: 'baseUrl',
    label: 'Base URL',
    description: 'Optional. Required for "custom" (any OpenAI-compatible endpoint); overrides the provider default.',
    type: 'text',
    placeholder: 'https://api.example.com',
    default: '',
  },
  {
    key: 'model',
    label: 'Model',
    description: 'Fetched live from the provider after your key is validated.',
    type: 'select',
    options: [],
    default: 'deepseek-chat',
  },
  {
    key: 'reasoningLevel',
    label: 'Reasoning Level',
    description: 'How much the model thinks before answering. Higher = deeper reasoning, slower.',
    type: 'select',
    options: ['none', 'low', 'medium', 'high'],
    default: 'medium',
  },
  {
    key: 'interleavedReasoning',
    label: 'Interleaved Reasoning',
    description: 'Stream the model step-by-step thinking inline, like Claude Code and Cursor.',
    type: 'toggle',
    default: true,
  },
];

const accessFields: ProfileField[] = [
  { key: 'canRunBash', label: 'Run shell commands', description: 'Run shell commands in a fresh clone of the repo.', type: 'toggle', default: true },
  { key: 'canRunTests', label: 'Run tests / build', type: 'toggle', default: true },
  { key: 'canSearchWeb', label: 'Search the web', type: 'toggle', default: false },
  {
    key: 'allowedPaths',
    label: 'Allowed paths',
    description: 'One glob per line. Blank = any path.',
    type: 'textarea',
    default: '',
  },
  {
    key: 'blockedPaths',
    label: 'Blocked paths',
    type: 'textarea',
    default: '',
  },
];

export const PLUGINS: Plugin[] = [
  {
    id: 'nixre-assistant',
    name: 'Nixre Assistant',
    description:
      'AI copilot for agentic engineering. Reads files, searches code, shows images, runs shell commands in a fresh clone of the repo, and searches the web. Per-repo access profiles decide what it may do.',
    icon: Bot,
    category: 'AI',
    tags: ['copilot', 'agentic', 'automation'],
    enabledByDefault: false,
    availableByDefault: false,
    hasForm: false,
    hasProfile: true,
    repoScoped: true,
    tools: assistantTools,
    providerFields,
    accessFields,
  },
];

export const PLUGIN_COUNT = PLUGINS.length;

export function getPlugin(id: string): Plugin | undefined {
  return PLUGINS.find(p => p.id === id);
}

export function isAssistantPlugin(plugin: Plugin): boolean {
  return plugin.id === 'nixre-assistant';
}

// Fields to render for a plugin's configuration surface.
export function fieldsFor(plugin: Plugin): ProfileField[] | undefined {
  if (isAssistantPlugin(plugin)) {
    return [...(plugin.providerFields ?? []), ...(plugin.accessFields ?? [])];
  }
  return plugin.profileFields;
}
