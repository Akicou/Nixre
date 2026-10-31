// Pure helpers behind the assistant's "work details" view: how a tool call is
// described in one quiet line, how consecutive steps are grouped, and which files
// a turn edited. No React here so it can be unit tested.
import type { MessagePart, ReasoningBlock, ToolCall } from './assistantEngine';

export type StepKind = 'read' | 'search' | 'edit' | 'run' | 'other';

export interface StepDescription {
  kind: StepKind;
  /** "Read", "Edited", "Ran" ... shown in the normal text colour. */
  verb: string;
  /** The file, query or command, shown in monospace and dimmed. */
  subject: string;
}

function args(tool: ToolCall): Record<string, unknown> {
  if (!tool.argsText) return {};
  try {
    const v = JSON.parse(tool.argsText);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function describeTool(tool: ToolCall): StepDescription {
  const a = args(tool);
  const path = str(a.path) || str(a.file_path) || str(a.file);
  switch (tool.name) {
    case 'read_file':
      return { kind: 'read', verb: 'Read', subject: path };
    case 'list_files':
      return { kind: 'read', verb: 'Listed', subject: path || '.' };
    case 'search_code':
      return { kind: 'search', verb: 'Searched', subject: str(a.query) || str(a.pattern) };
    case 'write_file':
      return { kind: 'edit', verb: str(a.action) === 'create' ? 'Created' : 'Edited', subject: path };
    case 'run_command':
    case 'run_tests':
      return { kind: 'run', verb: tool.name === 'run_tests' ? 'Ran tests' : 'Ran', subject: str(a.command) };
    case 'show_images':
      return { kind: 'read', verb: 'Viewed images', subject: '' };
    default:
      return { kind: 'other', verb: tool.name.replace(/_/g, ' '), subject: '' };
  }
}

export type WorkItem =
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'tool'; tool: ToolCall };

export type Block =
  | { kind: 'work'; key: string; items: WorkItem[] }
  | { kind: 'text'; key: string; text: string };

/** Consecutive reasoning and tool parts become one collapsible work block. Text stays inline. */
export function groupParts(parts: MessagePart[]): Block[] {
  const out: Block[] = [];
  parts.forEach((p, i) => {
    if (p.type === 'text') {
      out.push({ kind: 'text', key: `text-${i}`, text: p.text });
      return;
    }
    const item: WorkItem = p.type === 'tool' ? { type: 'tool', tool: p.tool } : { type: 'reasoning', id: p.id, text: p.text };
    const last = out[out.length - 1];
    if (last && last.kind === 'work') last.items.push(item);
    else out.push({ kind: 'work', key: `work-${i}`, items: [item] });
  });
  return out;
}

export interface WorkCounts {
  steps: number;
  read: number;
  search: number;
  edit: number;
  run: number;
  failed: number;
  pending: number;
}

export function countWork(items: WorkItem[]): WorkCounts {
  const c: WorkCounts = { steps: 0, read: 0, search: 0, edit: 0, run: 0, failed: 0, pending: 0 };
  for (const it of items) {
    if (it.type !== 'tool') continue;
    c.steps += 1;
    const { kind } = describeTool(it.tool);
    if (kind === 'read') c.read += 1;
    else if (kind === 'search') c.search += 1;
    else if (kind === 'edit') c.edit += 1;
    else if (kind === 'run') c.run += 1;
    if (it.tool.status === 'error') c.failed += 1;
    if (it.tool.status === 'running' || it.tool.status === 'approval') c.pending += 1;
  }
  return c;
}

/** "Read 3 files · Edited 2 · Ran 1 command" (empty when nothing notable). */
export function summarizeWork(c: WorkCounts): string {
  const bits: string[] = [];
  if (c.read) bits.push(`Read ${c.read} ${c.read === 1 ? 'file' : 'files'}`);
  if (c.search) bits.push(`Searched ${c.search}×`);
  if (c.edit) bits.push(`Edited ${c.edit}`);
  if (c.run) bits.push(`Ran ${c.run} ${c.run === 1 ? 'command' : 'commands'}`);
  if (c.failed) bits.push(`${c.failed} failed`);
  return bits.join(' · ');
}

export interface EditedFile {
  path: string;
  added: number | null;
  removed: number | null;
}

/** Files written by successful write_file calls. Counts come from "(+14 -2)" in the tool output when present. */
export function editedFiles(parts: MessagePart[]): EditedFile[] {
  const byPath = new Map<string, EditedFile>();
  for (const p of parts) {
    if (p.type !== 'tool' || p.tool.name !== 'write_file' || p.tool.status !== 'success') continue;
    const path = describeTool(p.tool).subject;
    if (!path) continue;
    const m = /\(\+(\d+)\s+-(\d+)\)/.exec(p.tool.output ?? '');
    const added = m ? Number(m[1]) : null;
    const removed = m ? Number(m[2]) : null;
    const prev = byPath.get(path);
    if (!prev) byPath.set(path, { path, added, removed });
    else {
      prev.added = prev.added === null || added === null ? null : prev.added + added;
      prev.removed = prev.removed === null || removed === null ? null : prev.removed + removed;
    }
  }
  return [...byPath.values()];
}

export function totalChanges(files: EditedFile[]): { added: number; removed: number } {
  return files.reduce(
    (t, f) => ({ added: t.added + (f.added ?? 0), removed: t.removed + (f.removed ?? 0) }),
    { added: 0, removed: 0 },
  );
}

export type { ReasoningBlock };
