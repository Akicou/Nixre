import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeAgentJob } from '../lib/agentJobs';

const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const snapshot = { type: 'snapshot', conversation: { id: 'conv', messages: [], run_status: 'running' } };
let streams: ReadableStreamDefaultController<Uint8Array>[];
let signals: AbortSignal[];
let cancelled = vi.fn(() => {});
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  streams = []; signals = []; cancelled = vi.fn();
  fetchMock = vi.fn(async (_url, options) => {
    signals.push(options.signal);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { streams.push(controller); controller.enqueue(encode(snapshot)); },
      cancel() { cancelled(); },
    }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Agent stream recovery', () => {
  it('reconnects a silently stalled stream without restarting the server job', async () => {
    const abort = new AbortController(), events = vi.fn();
    const follow = subscribeAgentJob('conv', events, abort.signal);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    expect(cancelled).toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([url]) => url === '/api/v1/ai/jobs/conv/events')).toBe(true);
    expect(events.mock.calls.filter(([event]) => event.type === 'snapshot')).toHaveLength(2);
    abort.abort(); await follow;
  });

  it('immediately replaces the stream on return from a background tab', async () => {
    const abort = new AbortController(), events = vi.fn();
    const follow = subscribeAgentJob('conv', events, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    streams[1].enqueue(encode({ type: 'done' }));
    await follow;
    expect(events).toHaveBeenLastCalledWith({ type: 'done' });
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a quiet command connected when server heartbeats arrive', async () => {
    const abort = new AbortController();
    const follow = subscribeAgentJob('conv', vi.fn(), abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i++) {
      streams[0].enqueue(encode({ type: 'heartbeat' }));
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    abort.abort(); await follow;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up when switching conversations and ignores late events', async () => {
    const abort = new AbortController(), events = vi.fn();
    const follow = subscribeAgentJob('conv', events, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    streams[0].enqueue(encode({ type: 'message_text', text: 'stale' }));
    abort.abort(); await follow;
    expect(events.mock.calls.some(([event]) => event.text === 'stale')).toBe(false);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
