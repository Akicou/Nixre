import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  skillPathFromTree,
  parseFrontmatter,
  parseSkillMarkdown,
  formatSkillCatalog,
  mentionedSkillNames,
  expandMentions,
} from './agentSkills.js';

describe('agentSkills', () => {
  it('picks SKILL.md paths under .nixre/skills', () => {
    const found = skillPathFromTree([
      '.nixre/skills/deploy/SKILL.md',
      '.nixre/skills/Deploy/SKILL.md',
      '.nixre/skills/ok/notes.md',
      'skills/deploy/SKILL.md',
      '.nixre/skills/ship-it/SKILL.md',
    ]);
    assert.deepEqual(
      found.map(f => f.name),
      ['deploy', 'ship-it'],
    );
  });

  it('parses frontmatter including disable-model-invocation', () => {
    const md = `---
name: deploy
description: Ship the service. Use when deploying or releasing.
disable-model-invocation: true
---

Run ./scripts/ship.sh
`;
    const parsed = parseSkillMarkdown(md, 'ignored');
    assert.equal(parsed.name, 'deploy');
    assert.match(parsed.description, /Ship the service/);
    assert.equal(parsed.disableModelInvocation, true);
    assert.equal(parsed.body, 'Run ./scripts/ship.sh');
  });

  it('rejects skills without a description', () => {
    assert.equal(parseSkillMarkdown('---\nname: x\n---\nbody', 'x'), null);
  });

  it('formats a catalog that marks user-only skills', () => {
    const catalog = formatSkillCatalog([
      { name: 'tdd', description: 'Write tests first', disableModelInvocation: false },
      { name: 'secrets', description: 'Handle credentials', disableModelInvocation: true },
    ]);
    assert.match(catalog, /invoke:model/);
    assert.match(catalog, /invoke:user/);
    assert.match(catalog, /read_skill/);
    assert.doesNotMatch(catalog, /Write the failing test/);
  });

  it('expands @skill before @file and leaves disable-model-invocation skills attachable', async () => {
    const skills = [
      {
        name: 'secrets',
        description: 'creds',
        disableModelInvocation: true,
        body: 'Never print tokens.',
      },
    ];
    const reads = [];
    const out = await expandMentions('use @secrets and @src/app.ts', {
      skills,
      execute: async (name, args) => {
        reads.push({ name, args });
        return 'export default 1';
      },
    });
    assert.match(out, /<attached_skills>/);
    assert.match(out, /Never print tokens/);
    assert.match(out, /<referenced_files>/);
    assert.match(out, /src\/app\.ts/);
    assert.deepEqual(reads, [{ name: 'read_file', args: { path: 'src/app.ts' } }]);
    assert.deepEqual(mentionedSkillNames('ping @secrets please', skills), ['secrets']);
  });

  it('parseFrontmatter handles quoted description', () => {
    const { meta } = parseFrontmatter('---\ndescription: "A: B"\n---\nbody');
    assert.equal(meta.description, 'A: B');
  });
});
