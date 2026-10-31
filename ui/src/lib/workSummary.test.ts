import { describe, it, expect } from 'vitest';
import type { MessagePart, ToolCall } from './assistantEngine';
import { countWork, describeTool, editedFiles, groupParts, summarizeWork, totalChanges } from './workSummary';

const tool = (name: string, argsText: string, extra: Partial<ToolCall> = {}): ToolCall => ({
  id: `${name}-${argsText}`, name, status: 'success', argsText, ...extra,
});

describe('describeTool', () => {
  it('turns tool calls into a verb and a subject', () => {
    expect(describeTool(tool('read_file', '{"path":"src/a.ts"}'))).toEqual({ kind: 'read', verb: 'Read', subject: 'src/a.ts' });
    expect(describeTool(tool('search_code', '{"query":"calculate"}'))).toMatchObject({ kind: 'search', subject: 'calculate' });
    expect(describeTool(tool('write_file', '{"path":"a.ts","action":"create"}'))).toMatchObject({ kind: 'edit', verb: 'Created' });
    expect(describeTool(tool('run_tests', '{"command":"npm test"}'))).toMatchObject({ kind: 'run', verb: 'Ran tests', subject: 'npm test' });
  });
  it('survives missing or broken arguments and unknown tools', () => {
    expect(describeTool(tool('read_file', 'not json')).subject).toBe('');
    expect(describeTool({ id: 'x', name: 'create_pull_request', status: 'success' })).toMatchObject({ kind: 'other', verb: 'create pull request' });
  });
});

describe('groupParts', () => {
  it('merges consecutive work parts and keeps text inline', () => {
    const parts: MessagePart[] = [
      { type: 'reasoning', id: 'r', text: 'thinking' },
      { type: 'tool', tool: tool('read_file', '{"path":"a"}') },
      { type: 'text', text: 'found it' },
      { type: 'tool', tool: tool('write_file', '{"path":"a"}') },
    ];
    expect(groupParts(parts).map(b => [b.kind, b.kind === 'work' ? b.items.length : 0])).toEqual([['work', 2], ['text', 0], ['work', 1]]);
  });
});

describe('countWork and summarizeWork', () => {
  it('counts by kind, failures and pending steps', () => {
    const items = [
      { type: 'tool' as const, tool: tool('read_file', '{"path":"a"}') },
      { type: 'tool' as const, tool: tool('read_file', '{"path":"b"}') },
      { type: 'tool' as const, tool: tool('write_file', '{"path":"a"}') },
      { type: 'tool' as const, tool: tool('run_command', '{"command":"ls"}', { status: 'error' }) },
      { type: 'tool' as const, tool: tool('run_command', '{"command":"ls"}', { status: 'running' }) },
    ];
    const c = countWork(items);
    expect(c).toMatchObject({ steps: 5, read: 2, edit: 1, run: 2, failed: 1, pending: 1 });
    expect(summarizeWork(c)).toBe('Read 2 files · Edited 1 · Ran 2 commands · 1 failed');
  });
});

describe('editedFiles', () => {
  it('lists successful writes with line counts and merges repeat edits', () => {
    const parts: MessagePart[] = [
      { type: 'tool', tool: tool('write_file', '{"path":"a.ts"}', { output: 'Updated a.ts (+14 -0)' }) },
      { type: 'tool', tool: tool('write_file', '{"path":"a.ts"}', { output: 'Updated a.ts (+1 -3)' }) },
      { type: 'tool', tool: tool('write_file', '{"path":"b.ts"}', { output: 'Created b.ts' }) },
      { type: 'tool', tool: tool('write_file', '{"path":"c.ts"}', { status: 'error', output: 'denied' }) },
    ];
    const files = editedFiles(parts);
    expect(files).toEqual([{ path: 'a.ts', added: 15, removed: 3 }, { path: 'b.ts', added: null, removed: null }]);
    expect(totalChanges(files)).toEqual({ added: 15, removed: 3 });
  });
});
