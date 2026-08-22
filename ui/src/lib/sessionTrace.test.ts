import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  tokensPerSecond,
  peelTrace,
  withTrace,
  toJsonl,
  TRACE_KIND,
  stamp,
  type SessionTraceEntry,
} from './sessionTrace';

describe('sessionTrace', () => {
  it('estimates tokens and tokens/sec', () => {
    expect(estimateTokens(400)).toBe(100);
    expect(tokensPerSecond(100, 2000)).toBe(50);
    expect(tokensPerSecond(0, 1000)).toBe(0);
  });

  it('hides the trace blob from chat messages and restores it on save', () => {
    const chat = [{ id: 'u1', role: 'user', content: 'hi', createdAt: 1 }];
    const entries: SessionTraceEntry[] = [
      stamp({
        type: 'model_change',
        provider: 'deepseek',
        modelId: 'deepseek-chat',
      }),
    ];
    const stored = withTrace(chat, entries);
    expect(stored).toHaveLength(2);
    expect((stored[1] as unknown as { kind: string }).kind).toBe(TRACE_KIND);

    const peeled = peelTrace(stored);
    expect(peeled.messages).toEqual(chat);
    expect(peeled.trace).toHaveLength(1);
    expect(peeled.trace[0].type).toBe('model_change');
  });

  it('serializes one JSON object per line', () => {
    const entries = [
      stamp({ type: 'thinking_level_change', thinkingLevel: 'high' }),
      stamp({ type: 'thinking_level_change', thinkingLevel: 'low' }),
    ];
    const lines = toJsonl(entries).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).thinkingLevel).toBe('high');
  });
});
