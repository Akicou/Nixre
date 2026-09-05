import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extForMime, sanitizeAttachmentName } from './agentSandbox.js';

describe('sanitizeAttachmentName', () => {
  it('keeps plain names intact', () => {
    assert.equal(sanitizeAttachmentName('research-paper1.pdf'), 'research-paper1.pdf');
    assert.equal(sanitizeAttachmentName('image1.png'), 'image1.png');
  });

  it('strips path components and hostile characters', () => {
    assert.equal(sanitizeAttachmentName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeAttachmentName('C:\\Users\\evil\\cmd.exe'), 'cmd.exe');
    assert.equal(sanitizeAttachmentName('weird/name<script>.png'), 'name_script_.png');
  });

  it('falls back when empty or dot-only', () => {
    assert.equal(sanitizeAttachmentName('', 'png'), 'attachment.png');
    assert.equal(sanitizeAttachmentName('...', 'png'), 'attachment.png');
  });

  it('caps length', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    assert.ok(sanitizeAttachmentName(long).length <= 120);
  });
});

describe('extForMime', () => {
  it('maps known mimes', () => {
    assert.equal(extForMime('image/png'), 'png');
    assert.equal(extForMime('application/pdf'), 'pdf');
    assert.equal(extForMime('text/plain'), 'txt');
  });

  it('falls back for unknown and generic image mimes', () => {
    assert.equal(extForMime('image/avif'), 'png');
    assert.equal(extForMime('application/x-unknown'), 'bin');
    assert.equal(extForMime(''), 'bin');
  });
});
