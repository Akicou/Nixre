// Append-only session log for /agent, shaped for distillation export.
//
// Modeled on pi-mono's JSONL session files (session header, model_change,
// thinking_level_change, plus turn metrics). Conversations store the entries
// as a hidden `session_trace` blob inside `messages` so no schema change is
// required; peel/attach keep it out of the chat UI and the model context.

export const TRACE_KIND = 'session_trace';

export interface TokenUsage {
  input: number;
  output: number;
  total?: number;
}

export type SessionTraceEntry =
  | {
      type: 'session';
      id: string;
      timestamp: string;
      repoPath: string;
      provider: string;
      modelId: string;
      thinkingLevel: string;
      mode: string;
      systemPrompt: string;
    }
  | {
      type: 'system_prompt_change';
      id: string;
      timestamp: string;
      mode: string;
      systemPrompt: string;
    }
  | {
      type: 'model_change';
      id: string;
      timestamp: string;
      provider: string;
      modelId: string;
    }
  | {
      type: 'thinking_level_change';
      id: string;
      timestamp: string;
      thinkingLevel: string;
    }
  | {
      type: 'reasoning_used';
      id: string;
      timestamp: string;
      thinkingLevel: string;
      chars: number;
      estimatedTokens: number;
    }
  | {
      type: 'turn_metrics';
      id: string;
      timestamp: string;
      modelId: string;
      provider: string;
      thinkingLevel: string;
      mode: string;
      elapsedMs: number;
      outputChars: number;
      reasoningChars: number;
      estimatedTokens: number;
      tokensPerSecond: number;
      usage?: TokenUsage;
    };

export interface SessionTraceBlob {
  id: string;
  kind: typeof TRACE_KIND;
  entries: SessionTraceEntry[];
  createdAt: number;
}

const isTraceBlob = (m: unknown): m is SessionTraceBlob =>
  Boolean(m && typeof m === 'object' && (m as SessionTraceBlob).kind === TRACE_KIND);

/** ~1 token / 4 chars — same heuristic pi uses when the provider omits usage. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

export function tokensPerSecond(tokens: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || tokens <= 0) return 0;
  return Math.round((tokens / (elapsedMs / 1000)) * 10) / 10;
}

export function newTraceId(): string {
  return `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** One variant of SessionTraceEntry without id/timestamp. Distributes over the union. */
export type SessionTraceDraft = SessionTraceEntry extends infer E
  ? E extends SessionTraceEntry
    ? Omit<E, 'id' | 'timestamp'>
    : never
  : never;

export function stamp(entry: SessionTraceDraft): SessionTraceEntry {
  return {
    ...entry,
    id: newTraceId(),
    timestamp: new Date().toISOString(),
  } as SessionTraceEntry;
}

export function peelTrace<T>(messages: T[]): { messages: T[]; trace: SessionTraceEntry[] } {
  const rest: T[] = [];
  const trace: SessionTraceEntry[] = [];
  for (const m of messages) {
    if (isTraceBlob(m)) trace.push(...(m.entries ?? []));
    else rest.push(m);
  }
  return { messages: rest, trace };
}

export function withTrace<T>(messages: T[], trace: SessionTraceEntry[]): T[] {
  const rest = messages.filter(m => !isTraceBlob(m));
  if (trace.length === 0) return rest;
  const blob: SessionTraceBlob = {
    id: 'session_trace',
    kind: TRACE_KIND,
    entries: trace,
    createdAt: Date.now(),
  };
  return [...rest, blob as unknown as T];
}

export function toJsonl(entries: SessionTraceEntry[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}

export function downloadJsonl(filename: string, entries: SessionTraceEntry[]): void {
  const blob = new Blob([toJsonl(entries)], { type: 'application/x-ndjson;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[^\w.-]+/g, '-');
  a.click();
  URL.revokeObjectURL(url);
}

export function lastTurnMetrics(entries: SessionTraceEntry[]): Extract<SessionTraceEntry, { type: 'turn_metrics' }> | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'turn_metrics') return entries[i] as Extract<SessionTraceEntry, { type: 'turn_metrics' }>;
  }
  return null;
}
