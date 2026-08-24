import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gitCredentialStoreLine } from './agentSandbox.js';

describe('gitCredentialStoreLine', () => {
  it('embeds user and token for git-credential-store without a trailing slash', () => {
    const line = gitCredentialStoreLine('http://nixre-core:3002', 'lyan', 'nxp_agent-sbx-abc_secret');
    assert.equal(line, 'http://lyan:nxp_agent-sbx-abc_secret@nixre-core:3002');
  });

  it('percent-encodes special characters in the password', () => {
    const line = gitCredentialStoreLine('http://nixre-core:3002', 'lyan', 'a:b@c');
    assert.match(line, /^http:\/\/lyan:.*@nixre-core:3002$/);
    assert.ok(!line.includes('a:b@c@'));
  });
});
