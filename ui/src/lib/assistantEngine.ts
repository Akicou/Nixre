// Nixre Assistant engine.
//
// Two parts:
//   * Conversation persistence - server-backed via nixre-sync (Postgres), so
//     chat sessions follow the account across browsers and devices.
//   * planTurn()/runTurn() - a deterministic, fully client-side mock agent
//     that drives the copilot UX: it "thinks", calls tools, and reports
//     results. Nixre ships no inference backend, so this runs in the browser.

import { getPlugin } from './plugins';
import type { AssistantProviderProfile } from './assistantProfiles';
import * as sync from './syncApi';

export type ToolStatus = 'running' | 'success' | 'error';

export interface ToolCall {
  id: string;
  name: string; // tool id, e.g. 'run_tests'
  status: ToolStatus;
  output?: string; // rendered output for a finished tool
}

export interface ReasoningBlock {
  id: string;
  text: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  reasoning?: ReasoningBlock[];
  createdAt: number;
}

export interface Conversation {
  id: string;
  repoPath: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

export type EngineEvent =
  | { type: 'reasoning'; blockId: string; text: string }
  | { type: 'tool_start'; tool: ToolCall }
  | { type: 'tool_output'; toolId: string; output: string }
  | { type: 'message_text'; text: string }
  | { type: 'done'; conversationId?: string; messageId?: string };

let seq = 0;
export const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Persistence (server-backed via nixre-sync)
// ---------------------------------------------------------------------------

function coerceConversation(c: sync.SyncConversation): Conversation {
  return {
    id: c.id,
    repoPath: c.repoPath,
    title: c.title,
    messages: Array.isArray(c.messages) ? (c.messages as ChatMessage[]) : [],
    updatedAt: c.updatedAt,
  };
}

export async function listConversations(repoPath?: string): Promise<Conversation[]> {
  const rows = await sync.listConversations(repoPath);
  return rows.map(coerceConversation).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const row = await sync.getConversation(id);
  return row ? coerceConversation(row) : undefined;
}

export async function createConversation(repoPath: string, title: string): Promise<Conversation> {
  const row = await sync.createConversation(repoPath, title.slice(0, 128));
  return coerceConversation(row);
}

export async function updateConversation(conversation: Conversation): Promise<void> {
  await sync.updateConversation(conversation.id, {
    title: conversation.title,
    messages: conversation.messages,
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await sync.deleteConversation(id);
}

// ---------------------------------------------------------------------------
// Turn planning (pure)
// ---------------------------------------------------------------------------

const toolOutput = (name: string, prompt: string): string => {
  const p = prompt.toLowerCase();
  if (name === 'run_tests') {
    if (p.includes('failing') || p.includes('fix')) {
      return `Running test suite...
FAIL src/lib/api.ts
  × rejects on unauthorized (12ms)

Test Files  1 failed, 1 passed (2)
Tests       1 failed, 14 passed (15)`;
    }
    return `Running test suite...
✓ src/lib/duration.ts (3 tests)
✓ src/lib/api.ts (12 tests)
Test Files  2 passed (2)
Tests       15 passed (15)`;
  }
  if (name === 'web_search') {
    return `Searching the web...
→ docs.nixre.dev/plugins — enabling and configuring plugins
→ GitHub Akicou/Nixre — the plugin registry (providerFields/accessFields)
→ deepseek.ai/docs — reasoning_level and output_tokens`;
  }
  if (name === 'file_read') {
    return `README.md (5,356 bytes)
# Nixre
Sovereign, minimalist, and ultra-fast code collaboration forge...`;
  }
  if (name === 'bash') {
    return `$ npm test
> nixre-ui@1.0.0 test
> vitest run
Test Files  21 passed (21)
Tests       117 passed (117)`;
  }
  return '';
};

const scenarioFor = (prompt: string): string[] => {
  const p = prompt.toLowerCase();
  if (p.includes('vuln') || p.includes('security') || p.includes('secret') || p.includes('scan')) {
    return ['file_read', 'web_search'];
  }
  if (p.includes('test') || p.includes('run') || p.includes('build')) {
    return ['run_tests'];
  }
  if (p.includes('bug') || p.includes('fix') || p.includes('error')) {
    return ['file_read', 'bash'];
  }
  if (p.includes('pr') || p.includes('pull') || p.includes('review')) {
    return ['file_read', 'run_tests', 'web_search'];
  }
  return ['file_read', 'web_search'];
};

const reasoningTemplates: Record<string, string[]> = {
  review: [
    'I will read the changed files, run the suite, and cross-check the docs.',
    'Now I will verify the build and tests pass before summarizing.',
  ],
  default: ['Reading the repo context first.', 'Then I will run the requested checks.'],
};

// Deterministic event sequence for a prompt. `interleavedReasoning` + the
// reasoning level control how many thinking blocks are emitted.
export function planTurn(prompt: string, profile: AssistantProviderProfile): EngineEvent[] {
  const events: EngineEvent[] = [];
  const tools = scenarioFor(prompt);
  const reasoningOn = profile.interleavedReasoning;
  const reasonBlocks = { none: 0, low: 1, medium: 2, high: 3 }[profile.reasoningLevel ?? 'none'] ?? 0;

  // Distribute the reasoning blocks across the tool calls so thinking is
  // interleaved with execution (up to `reasonBlocks` total).
  const candidates = [...reasoningTemplates.review, ...reasoningTemplates.default];
  const reasoningTexts = reasoningOn ? candidates.slice(0, reasonBlocks) : [];
  let rIdx = 0;
  const pushReasoning = () => {
    if (rIdx < reasoningTexts.length) {
      const blockId = uid('reason');
      events.push({ type: 'reasoning', blockId, text: reasoningTexts[rIdx++] });
    }
  };

  for (const name of tools) {
    pushReasoning();
    const tool: ToolCall = { id: uid('tool'), name, status: 'running' };
    events.push({ type: 'tool_start', tool });
    events.push({ type: 'tool_output', toolId: tool.id, output: toolOutput(name, prompt) });
  }
  while (rIdx < reasoningTexts.length) pushReasoning();

  const summary = buildSummary(tools, prompt);
  events.push({ type: 'message_text', text: summary });
  events.push({ type: 'done' });
  return events;
}

const buildSummary = (tools: string[], prompt: string): string => {
  const p = prompt.toLowerCase();
  if (tools.includes('run_tests') && (p.includes('failing') || p.includes('fix'))) {
    return "I found **1 failing test** in `src/lib/api.ts` (auth handling). Want me to open a fix branch and patch it? With your per-repo profile I can edit files, run tests, and open a PR automatically.";
  }
  if (tools.includes('web_search') && p.includes('vuln')) {
    return "No exposed secrets or critical CVEs in the changed files. Two advisories in dependencies could be bumped — want me to open PRs for the fixes?";
  }
  if (tools.includes('run_tests')) {
    return "The suite is green: **15 tests passing** across 2 files. Build and lint are clean. Nothing blocking for this change.";
  }
  if (tools.includes('web_search')) {
    return "I checked the docs and the repo. Plugins are gated by a server allowlist plus a per-user toggle — see `ui/src/lib/plugins.ts`. Want me to enable one for you?";
  }
  return "I'm ready to help with this repo. I can read files, run the build/tests, search the web, and (with your access profile) edit, commit, and open PRs. What would you like to do?";
};

// ---------------------------------------------------------------------------
// Streaming (wraps planTurn with small delays)
// ---------------------------------------------------------------------------

export async function* runTurn(
  prompt: string,
  profile: AssistantProviderProfile,
  delay = 45,
): AsyncGenerator<EngineEvent> {
  const plan = planTurn(prompt, profile);
  for (const event of plan) {
    if (delay) await sleep(delay);
    yield event;
  }
}

export { getPlugin };
