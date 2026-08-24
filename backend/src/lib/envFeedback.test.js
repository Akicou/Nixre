import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectToolFailures,
  normalizeReport,
  formatEnvAuditContext,
  saveEnvFeedback,
  SANDBOX_IMAGE_RECIPE,
} from './envFeedback.js';

describe('envFeedback', () => {
  it('caps and normalizes the report shape', () => {
    const report = normalizeReport({
      missing_binaries: ['rg', '  curl  ', '', 'x'.repeat(300)],
      notes: '  slim image  ',
      extra: 'drop me',
    });
    assert.equal(report.missing_packages.length, 0);
    assert.equal(report.missing_binaries[0], 'rg');
    assert.equal(report.missing_binaries[1], 'curl');
    assert.equal(report.missing_binaries[2].length, 200);
    assert.equal(report.notes, 'slim image');
    assert.equal(report.extra, undefined);
  });

  it('collects command-not-found and permission failures from tool parts', () => {
    const hits = collectToolFailures([
      {
        role: 'assistant',
        parts: [
          { type: 'tool', tool: { name: 'run_command', output: 'bash: rg: command not found' } },
          { type: 'tool', tool: { name: 'web_search', status: 'error', output: "web_search requires the 'Search the web' permission" } },
          { type: 'tool', tool: { name: 'list_files', output: '12 files' } },
        ],
      },
    ]);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].name, 'run_command');
    assert.equal(hits[1].name, 'web_search');
  });

  it('audit context includes the slim recipe and failures', () => {
    const ctx = formatEnvAuditContext({
      permissions: { canSearchWeb: false, canRunBash: true },
      tools: ['run_command', 'read_skill'],
      failures: [{ name: 'run_command', output: 'jq: command not found' }],
    });
    assert.match(ctx, /<env_audit>/);
    assert.match(ctx, new RegExp(SANDBOX_IMAGE_RECIPE.base));
    assert.match(ctx, /submit_env_feedback/);
    assert.match(ctx, /jq: command not found/);
    assert.match(ctx, /"canSearchWeb": false/);
  });

  it('saveEnvFeedback inserts a normalized row', async () => {
    const inserted = [];
    const pool = {
      async query(sql, params) {
        inserted.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    };
    const saved = await saveEnvFeedback(pool, {
      userId: 'lyan',
      conversationId: 'conv_1',
      repoPath: 'acme/website',
      report: { missing_binaries: ['rg'], notes: 'need ripgrep' },
    });
    assert.equal(saved.saved, true);
    assert.equal(saved.report.missing_binaries[0], 'rg');
    assert.match(inserted[0].sql, /INSERT INTO agent_env_feedback/);
    assert.equal(inserted[0].params[1], 'lyan');
    assert.equal(JSON.parse(inserted[0].params[4]).notes, 'need ripgrep');
  });
});
