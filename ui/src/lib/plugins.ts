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
// This mirrors the existing authLock.ts pattern: the UI holds preferences in
// localStorage, while real enforcement lives on the server. There is deliberately
// no REST endpoint here - Gitness (the backend) exposes none of this, so state
// stays local until a backend is added. See the `backendHooks` note per plugin.

import {
  Bot,
  Workflow,
  ShieldAlert,
  Bug,
  MessageSquare,
  Webhook,
  Puzzle,
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
// Runs inside an isolated Docker environment and is given a tool set. The active
// profile selects the AI provider; per-repo profiles control what it may do.
// ---------------------------------------------------------------------------

const assistantTools: PluginTool[] = [
  { name: 'file_read', description: 'Read a file. Paths pointing to images are read analytically (multimodal).' },
  { name: 'file_write', description: 'Write or modify files in the repository.' },
  { name: 'bash', description: 'Run shell commands inside the isolated Docker agentic sandbox.' },
  { name: 'run_tests', description: 'Run the repo build, tests and lint inside the Docker sandbox.' },
  { name: 'web_search', description: 'Search the web for up-to-date docs, APIs and fixes.' },
  { name: 'git', description: 'Create branches, commit, push and open pull requests.' },
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
    key: 'temperature',
    label: 'Temperature',
    description: 'Lower = focused, higher = more creative.',
    type: 'range',
    min: 0,
    max: 2,
    step: 0.1,
    default: 0.2,
  },
  {
    key: 'maxTokens',
    label: 'Max Output Tokens',
    type: 'number',
    min: 256,
    max: 128000,
    step: 256,
    default: 8192,
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
  {
    key: 'accessLevel',
    label: 'Access Level',
    description: 'How much the assistant may do in this repository.',
    type: 'select',
    options: ['read-only', 'read-write', 'full-agent'],
    default: 'read-only',
  },
  { key: 'canEditFiles', label: 'Edit files', type: 'toggle', default: false },
  { key: 'canRunBash', label: 'Run bash (Docker sandbox)', type: 'toggle', default: false },
  { key: 'canRunTests', label: 'Run tests / build', type: 'toggle', default: false },
  { key: 'canSearchWeb', label: 'Search the web', type: 'toggle', default: false },
  { key: 'canPush', label: 'Push commits / open PRs', type: 'toggle', default: false },
  { key: 'canMerge', label: 'Merge pull requests', type: 'toggle', default: false },
  {
    key: 'autoMergeBranch',
    label: 'Auto-merge target branch',
    description: 'Leave blank to disable the merge gate. The assistant will test a PR into this branch and only merge when everything passes.',
    type: 'text',
    placeholder: 'main',
    default: '',
  },
  { key: 'autoMergeOnGreen', label: 'Auto-merge when checks pass', type: 'toggle', default: false },
  { key: 'autoFixBugs', label: 'Auto-fix bugs it finds', type: 'toggle', default: false },
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

// ---------------------------------------------------------------------------
// The 6 additional invented plugins.
// ---------------------------------------------------------------------------

const ciFormFields: ProfileField[] = [
  {
    key: 'triggerBranches',
    label: 'Trigger branches',
    description: 'One glob per line. Blank = every branch.',
    type: 'textarea',
    default: '',
  },
  {
    key: 'pipeline',
    label: 'Default pipeline',
    type: 'textarea',
    placeholder: '# build\nnpm install && npm run build\n# test\nnpm test',
    default: '',
  },
  { key: 'failOnWarnings', label: 'Fail on warnings', type: 'toggle', default: false },
];

const securityFormFields: ProfileField[] = [
  {
    key: 'severity',
    label: 'Minimum severity',
    type: 'select',
    options: ['info', 'low', 'medium', 'high', 'critical'],
    default: 'medium',
  },
  { key: 'scanSecrets', label: 'Scan for exposed secrets', type: 'toggle', default: true },
  { key: 'scanDeps', label: 'Scan dependencies for CVEs', type: 'toggle', default: true },
  { key: 'scanSast', label: 'Static analysis (SAST)', type: 'toggle', default: true },
  {
    key: 'failOnCritical',
    label: 'Block merge on critical/high findings',
    type: 'toggle',
    default: true,
  },
];

const issuesFormFields: ProfileField[] = [
  {
    key: 'defaultTemplate',
    label: 'Default issue template',
    type: 'textarea',
    placeholder: '## What\n\n## Expected\n## Actual',
    default: '',
  },
  { key: 'requireTemplate', label: 'Require a template', type: 'toggle', default: false },
  { key: 'publicIssues', label: 'Allow public issue comments', type: 'toggle', default: false },
];

const reviewFormFields: ProfileField[] = [
  { key: 'autoAssign', label: 'Auto-assign reviewers', type: 'toggle', default: false },
  { key: 'requiredReviewers', label: 'Required reviewers before merge', type: 'number', min: 0, max: 10, step: 1, default: 1 },
  { key: 'wipAllowed', label: 'Allow WIP pull requests', type: 'toggle', default: true },
];

const membersFormFields: ProfileField[] = [
  {
    key: 'defaultRole',
    label: 'New member default role',
    type: 'select',
    options: ['reader', 'reporter', 'developer', 'maintainer', 'owner'],
    default: 'reader',
  },
  { key: 'allowExternal', label: 'Allow members outside the space owner', type: 'toggle', default: false },
];

const webhookFormFields: ProfileField[] = [
  {
    key: 'url',
    label: 'Callback URL',
    type: 'text',
    placeholder: 'https://example.com/hooks/nixre',
    default: '',
  },
  { key: 'onPush', label: 'on push', type: 'toggle', default: true },
  { key: 'onPullRequest', label: 'on pull request', type: 'toggle', default: true },
  { key: 'onIssue', label: 'on issue', type: 'toggle', default: false },
  {
    key: 'secret',
    label: 'Signing secret',
    description: 'Used to sign the payload so receivers can verify it.',
    type: 'secret',
    placeholder: 'shared-secret',
    default: '',
  },
];

export const PLUGINS: Plugin[] = [
  {
    id: 'nixre-assistant',
    name: 'Nixre Assistant',
    description:
      'AI copilot for agentic engineering. Runs in an isolated Docker environment with file, shell, test, web and git tools. Per-repo access profiles decide what it may do, including PR merge gates and auto-fixes.',
    icon: Bot,
    category: 'AI',
    tags: ['copilot', 'agentic', 'docker', 'automation'],
    enabledByDefault: false,
    availableByDefault: false,
    hasForm: false,
    hasProfile: true,
    repoScoped: true,
    tools: assistantTools,
    providerFields,
    accessFields,
  },
  {
    id: 'ci-cd-pipelines',
    name: 'CI/CD Pipelines',
    description:
      'Surface Gitness CI runs in the UI: trigger and re-run pipelines, watch status and read live logs without leaving Nixre.',
    icon: Workflow,
    category: 'CI/CD',
    tags: ['continuous-integration', 'gitness', 'build'],
    enabledByDefault: false,
    availableByDefault: false,
    hasForm: true,
    hasProfile: false,
    profileFields: ciFormFields,
  },
  {
    id: 'security-scanner',
    name: 'Security Scanner',
    description:
      'Scan repositories and pull requests for exposed secrets, vulnerable dependencies and static-analysis issues.',
    icon: ShieldAlert,
    category: 'Security',
    tags: ['sast', 'secrets', 'cve', 'vulnerability'],
    enabledByDefault: false,
    availableByDefault: false,
    hasForm: true,
    hasProfile: false,
    profileFields: securityFormFields,
  },
  {
    id: 'issues-tracker',
    name: 'Issues Tracker',
    description:
      'Create, list, assign, label and close issues directly from a repository.',
    icon: Bug,
    category: 'Project Management',
    tags: ['issues', 'tracking', 'projects'],
    enabledByDefault: false,
    availableByDefault: false,
    hasForm: true,
    hasProfile: false,
    profileFields: issuesFormFields,
  },
  {
    id: 'code-review',
    name: 'Code Review',
    description:
      'Inline, line-level review threads on pull requests with auto-assignment and required reviewers.',
    icon: MessageSquare,
    category: 'Review',
    tags: ['review', 'pull-requests', 'inline'],
    enabledByDefault: false,
    availableByDefault: false,
    hasForm: true,
    hasProfile: false,
    profileFields: reviewFormFields,
  },
  {
    id: 'members-access',
    name: 'Members & Access',
    description:
      'Manage space members, roles and per-repository permissions with reusable role profiles.',
    icon: Webhook,
    category: 'Administration',
    tags: ['members', 'roles', 'permissions', 'teams'],
    enabledByDefault: false,
    availableByDefault: false,
    hasForm: true,
    hasProfile: false,
    profileFields: membersFormFields,
  },
  {
    id: 'webhooks-integrations',
    name: 'Webhooks & Integrations',
    description:
      'Subscribe repository events to external URLs with signed payloads for Slack, Discord and more.',
    icon: Puzzle,
    category: 'Integrations',
    tags: ['webhooks', 'slack', 'discord', 'notifications'],
    enabledByDefault: false,
    availableByDefault: false,
    hasForm: true,
    hasProfile: false,
    profileFields: webhookFormFields,
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
