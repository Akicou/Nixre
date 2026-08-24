// Agent skills — repo-local SKILL.md files with catalog-only prompt injection.
//
// Skills live at `.nixre/skills/<name>/SKILL.md` on HEAD. Every agent turn
// gets a compact catalog (name + description). The full body is loaded when
// the user @mentions the skill or the model calls read_skill.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoDir } from '../git/repo.js';

const exec = promisify(execFile);

export const SKILL_ROOT = '.nixre/skills';
const SKILL_PATH_RE = /^\.nixre\/skills\/([a-z0-9][a-z0-9-]{0,62})\/SKILL\.md$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_SKILLS = 40;
const MAX_SKILL_BYTES = 48 * 1024;

export const READ_SKILL_SCHEMA = {
  name: 'read_skill',
  description:
    'Load the full SKILL.md body for a repository skill listed under available_skills. Call this when the current task matches the skill description. Do not call it for skills marked invoke:user unless the user @mentioned that skill. Supporting files in the skill directory can be read with read_file.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill directory name (e.g. deploy)' },
    },
    required: ['name'],
  },
};

async function git(dir, args) {
  const { stdout } = await exec('git', ['-C', dir, ...args], {
    maxBuffer: MAX_SKILL_BYTES + 1024,
    timeout: 15_000,
    encoding: 'utf8',
  });
  return stdout;
}

export function skillPathFromTree(paths) {
  const out = [];
  for (const p of paths) {
    const m = String(p || '').match(SKILL_PATH_RE);
    if (m) out.push({ name: m[1], path: p });
  }
  return out.slice(0, MAX_SKILLS);
}

export function parseFrontmatter(md) {
  const text = String(md || '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val === 'true' || val === 'false') meta[kv[1]] = val === 'true';
    else meta[kv[1]] = val;
  }
  return { meta, body: m[2].trim() };
}

export function parseSkillMarkdown(md, fallbackName) {
  const { meta, body } = parseFrontmatter(md);
  const name = NAME_RE.test(String(meta.name || '')) ? String(meta.name) : fallbackName;
  if (!NAME_RE.test(name || '')) return null;
  const description = String(meta.description || '').trim().slice(0, 1024);
  if (!description) return null;
  return {
    name,
    description,
    disableModelInvocation: meta['disable-model-invocation'] === true,
    body,
  };
}

export function formatSkillCatalog(skills) {
  if (!skills?.length) return '';
  const lines = skills.map(s => {
    const invoke = s.disableModelInvocation ? 'user' : 'model';
    return `- ${s.name} (invoke:${invoke}): ${s.description}`;
  });
  return `<available_skills>
Repository skills at .nixre/skills. Only this catalog is in context.
Call read_skill with a skill name when the task matches its description.
Skills marked invoke:user must not be loaded unless the user @mentioned them.
@name in the user message also attaches that skill's body.

${lines.join('\n')}
</available_skills>`;
}

export function mentionedSkillNames(prompt, skills) {
  const names = new Set((skills || []).map(s => s.name));
  const found = [];
  for (const m of String(prompt || '').matchAll(/(?:^|\s)@([\w./-]+)/g)) {
    const token = m[1];
    if (names.has(token) && !found.includes(token)) found.push(token);
  }
  return found;
}

export async function listSkills(space, repo) {
  let dir;
  try {
    dir = repoDir(space, repo);
  } catch {
    return [];
  }
  let out = '';
  try {
    out = await git(dir, ['ls-tree', '-r', '--name-only', 'HEAD', '--', SKILL_ROOT]);
  } catch {
    return [];
  }
  const entries = skillPathFromTree(out.split('\n').filter(Boolean));
  const skills = [];
  for (const e of entries) {
    try {
      const raw = await git(dir, ['show', `HEAD:${e.path}`]);
      const parsed = parseSkillMarkdown(String(raw).slice(0, MAX_SKILL_BYTES), e.name);
      if (parsed) {
        skills.push({
          ...parsed,
          path: e.path,
          body: parsed.body.slice(0, MAX_SKILL_BYTES),
        });
      }
    } catch {
      /* skip unreadable */
    }
  }
  return skills;
}

export async function readSkill(space, repo, name, skills) {
  const id = String(name || '').trim();
  if (!NAME_RE.test(id)) throw new Error('Unknown skill');
  const list = skills || (await listSkills(space, repo));
  const skill = list.find(s => s.name === id);
  if (!skill) throw new Error(`Unknown skill '${id}'`);
  return `# ${skill.name}\n\n${skill.body}`;
}

export async function expandMentions(prompt, { execute, skills }) {
  const mentions = [...String(prompt).matchAll(/(?:^|\s)@([\w./-]+)/g)].map(m => m[1]).slice(0, 5);
  if (mentions.length === 0) return prompt;
  const skillByName = new Map((skills || []).map(s => [s.name, s]));
  const fileSnippets = [];
  const skillSnippets = [];
  const seen = new Set();
  for (const p of mentions) {
    if (seen.has(p)) continue;
    seen.add(p);
    const skill = skillByName.get(p);
    if (skill) {
      skillSnippets.push(`--- skill:${skill.name} ---\n${skill.body}`);
      continue;
    }
    try {
      const content = await execute('read_file', { path: p });
      fileSnippets.push(`--- ${p} ---\n${content}`);
    } catch {
      fileSnippets.push(`--- ${p} --- (could not read)`);
    }
  }
  const parts = [];
  if (skillSnippets.length) {
    parts.push(`<attached_skills>\n${skillSnippets.join('\n\n')}\n</attached_skills>`);
  }
  if (fileSnippets.length) {
    parts.push(`<referenced_files>\n${fileSnippets.join('\n\n')}\n</referenced_files>`);
  }
  if (parts.length === 0) return prompt;
  return `${parts.join('\n\n')}\n\n${prompt}`;
}
