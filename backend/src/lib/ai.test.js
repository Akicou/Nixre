import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractReasoningTexts } from './ai.js';

describe('extractReasoningTexts', () => {
  it('collects reasoning from a single field', () => {
    assert.deepEqual(extractReasoningTexts({ reasoning_content: 'think harder' }), [
      'think harder',
    ]);
  });

  it('dedupes identical text across reasoning + reasoning_details (OpenRouter)', () => {
    const src = {
      reasoning: 'step one',
      reasoning_details: [{ type: 'reasoning.text', text: 'step one' }],
    };
    assert.deepEqual(extractReasoningTexts(src), ['step one']);
  });

  it('dedupes identical text across thinking + reasoning_content (vLLM/Qwen)', () => {
    const src = { thinking: 'why?', reasoning_content: 'why?' };
    assert.deepEqual(extractReasoningTexts(src), ['why?']);
  });

  it('keeps distinct reasoning stages in order', () => {
    const src = {
      thinking: 'stage one',
      reasoning: 'stage two',
    };
    assert.deepEqual(extractReasoningTexts(src), ['stage one', 'stage two']);
  });

  it('de-dupes identical text even when one copy has padding whitespace', () => {
    const src = { reasoning: 'same', reasoning_content: ' same ' };
    // reasoning_content is read first, so its original form is retained — but
    // the text is emitted exactly once (not doubled).
    assert.equal(extractReasoningTexts(src).length, 1);
  });

  it('handles structured reasoning object content/text', () => {
    const src = { reasoning: { content: 'from content' } };
    assert.deepEqual(extractReasoningTexts(src), ['from content']);
  });

  it('handles non-object and empty sources', () => {
    assert.deepEqual(extractReasoningTexts(null), []);
    assert.deepEqual(extractReasoningTexts(undefined), []);
    assert.deepEqual(extractReasoningTexts('nope'), []);
    assert.deepEqual(extractReasoningTexts({}), []);
  });
});
