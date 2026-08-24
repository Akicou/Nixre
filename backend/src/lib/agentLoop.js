// Server-side port of ui runRealTurn. Streams via streamChat, runs tools via
// executeTool, and emits EngineEvents the UI already knows how to apply.

import { streamChat } from './ai.js';
import { formatCompactionForPrompt, toMultimodalParts } from './chatApply.js';

export const MAX_POST_TOOL_RETRIES = 3;

let reasonSeq = 0;

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} [opts.extraContext]
 * @param {string} [opts.compactionSummary]
 * @param {Array} opts.history
 * @param {string} opts.prompt
 * @param {Array} [opts.images]
 * @param {string} opts.provider
 * @param {string|null} opts.apiKey
 * @param {string} [opts.baseUrl]
 * @param {string} opts.model
 * @param {string} [opts.reasoningLevel]
 * @param {Array|null} opts.tools
 * @param {AbortSignal} [opts.signal]
 * @param {(evt: object) => void} emit
 * @param {object} [deps]
 */
export async function runAgentLoop(opts, emit, deps = {}) {
  const stream = deps.streamChat || streamChat;
  const execute = deps.executeTool;
  const touch = deps.touchSandbox;
  const steerNext = deps.steerNext || (() => null);
  const signal = opts.signal;
  const useTools = Array.isArray(opts.tools) && opts.tools.length > 0 && typeof execute === 'function';

  if (useTools && touch) void touch().catch(() => {});

  const thread = [
    { role: 'system', content: opts.systemPrompt },
    ...(opts.extraContext
      ? [{ role: 'system', content: `<attached_context>\n${opts.extraContext}\n</attached_context>` }]
      : []),
    ...(opts.compactionSummary
      ? [{ role: 'system', content: formatCompactionForPrompt(opts.compactionSummary) }]
      : []),
    ...(opts.history || []).slice(-20).map(m => {
      if (m.role === 'user' && m.images && m.images.length > 0) {
        return {
          role: 'user',
          content: toMultimodalParts(typeof m.content === 'string' ? m.content : '', m.images),
        };
      }
      return { role: m.role, content: typeof m.content === 'string' ? m.content : '' };
    }),
    {
      role: 'user',
      content:
        opts.images && opts.images.length > 0
          ? toMultimodalParts(opts.prompt, opts.images)
          : opts.prompt,
    },
  ];

  let errored = null;
  let aborted = false;
  let afterTools = false;

  const streamStep = () =>
    new Promise(resolve => {
      const pending = new Map();
      const started = new Set();
      let stepText = '';
      let stepTextLive = false;
      let roundToolSeen = false;
      let currentBlockId = null;
      let settled = false;

      const settle = () => {
        if (settled) return;
        settled = true;
        const all = [...pending.values()];
        const calls = all
          .filter(c => c.id && c.name)
          .map(c => ({ id: c.id, name: c.name, args: c.args }));
        if (calls.length === 0 && all.length > 0) {
          errored = errored ?? 'Model returned an incomplete tool call';
        }
        resolve({ calls, text: stepText });
      };

      const replaySuppressedText = () => {
        const hasToolCalls = [...pending.values()].some(c => c.id && c.name);
        if (!hasToolCalls && stepText && !stepTextLive) {
          stepTextLive = true;
          emit({ type: 'message_text', text: stepText });
        }
      };

      stream(
        {
          provider: opts.provider,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
          model: opts.model,
          messages: thread,
          reasoningLevel: opts.reasoningLevel || 'none',
          tools: useTools ? opts.tools : null,
          signal,
        },
        async evt => {
          if (evt.type === 'reasoning') {
            currentBlockId ||= `reason_${Date.now()}_${reasonSeq++}`;
            emit({ type: 'reasoning', blockId: currentBlockId, text: evt.text });
          } else if (evt.type === 'text') {
            currentBlockId = null;
            stepText += evt.text;
            if (!useTools || !roundToolSeen) {
              stepTextLive = true;
              emit({ type: 'message_text', text: evt.text });
            }
          } else if (evt.type === 'tool_delta') {
            if (useTools && !roundToolSeen && stepTextLive) {
              emit({ type: 'step_clear_preamble' });
              stepTextLive = false;
            }
            roundToolSeen = true;
            const cur = pending.get(evt.index) ?? { args: '' };
            if (evt.id) cur.id = evt.id;
            if (evt.name) cur.name = evt.name;
            if (evt.argsDelta) cur.args += evt.argsDelta;
            pending.set(evt.index, cur);
            if (cur.id && cur.name && !started.has(cur.id)) {
              started.add(cur.id);
              emit({
                type: 'tool_start',
                tool: { id: cur.id, name: cur.name, status: 'running', argsText: cur.args },
              });
            } else if (cur.id && started.has(cur.id) && evt.argsDelta) {
              emit({
                type: 'tool_start',
                tool: { id: cur.id, name: cur.name || '', status: 'running', argsText: cur.args },
              });
            }
          } else if (evt.type === 'usage') {
            emit({ type: 'usage', usage: evt.usage });
          } else if (evt.type === 'finish') {
            if (useTools && evt.reason === 'stop' && stepText && !stepTextLive) {
              stepTextLive = true;
              emit({ type: 'message_text', text: stepText });
            }
          } else if (evt.type === 'error') {
            errored = evt.message;
          }
        },
      ).then(
        () => {
          replaySuppressedText();
          settle();
        },
        err => {
          if (err && err.name === 'AbortError') aborted = true;
          else errored = err instanceof Error ? err.message : 'The AI provider request failed.';
          settle();
        },
      );
    });

  while (true) {
    if (signal?.aborted) aborted = true;
    let calls = [];
    let text = '';
    let attempt = 0;

    while (true) {
      errored = null;
      ({ calls, text } = await streamStep());
      if (aborted) break;
      if (!errored) break;
      if (afterTools && attempt < MAX_POST_TOOL_RETRIES) {
        attempt++;
        emit({ type: 'stream_retry' });
        continue;
      }
      break;
    }

    if (aborted || errored) break;
    if (!useTools || calls.length === 0) break;

    thread.push({
      role: 'assistant',
      content: text,
      tool_calls: calls.map(c => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args },
      })),
    });

    for (const call of calls) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      if (touch) void touch().catch(() => {});
      let argsObj = {};
      try {
        argsObj = call.args ? JSON.parse(call.args) : {};
      } catch {
        argsObj = {};
      }
      emit({
        type: 'tool_start',
        tool: { id: call.id, name: call.name, status: 'running', argsText: call.args },
      });
      try {
        const output = await execute(call.name, argsObj);
        emit({ type: 'tool_output', toolId: call.id, output });
        thread.push({ role: 'tool', tool_call_id: call.id, content: output });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Tool execution failed';
        emit({ type: 'tool_error', toolId: call.id, output: msg });
        thread.push({ role: 'tool', tool_call_id: call.id, content: `Error: ${msg}` });
      }
    }
    if (aborted) break;

    const steer = await steerNext();
    if (steer) {
      thread.push({
        role: 'user',
        content:
          steer.images && steer.images.length > 0
            ? toMultimodalParts(steer.text, steer.images)
            : steer.text,
      });
      emit({
        type: 'steer_applied',
        prompt: steer.text,
        ...(steer.images && steer.images.length > 0 ? { images: steer.images } : {}),
      });
    }
    afterTools = true;
  }

  if (errored) {
    const err = new Error(
      afterTools ? `${errored} (failed after ${MAX_POST_TOOL_RETRIES + 1} attempts)` : errored,
    );
    throw err;
  }
  if (aborted) {
    const err = new Error('Turn stopped');
    err.name = 'AbortError';
    throw err;
  }
}
