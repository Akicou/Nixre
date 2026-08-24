// Agent environment feedback — structured reports about the slim sandbox
// image, Nixre tools, and repo access gates. Suggestions only; never applied.

export const SANDBOX_IMAGE_RECIPE = {
  image: 'nixre-agent-sandbox:latest',
  base: 'node:22-bookworm-slim',
  apt: ['bash', 'ca-certificates', 'coreutils', 'git', 'g++', 'make', 'python3'],
  runtime: 'node 22 + python3',
  notes:
    'Intentionally slim. Session apt/npm/pip installs persist on the conversation volume until the sandbox is idle-stopped; they are not baked into the image.',
};

export const ENV_AUDIT_PROMPT =
  'Audit this agent sandbox and Nixre tools for gaps from this session. Probe the environment, call submit_env_feedback, then summarize what is missing vs what is a permission gate. Do not edit the Dockerfile.';

export const SUBMIT_ENV_FEEDBACK_SCHEMA = {
  name: 'submit_env_feedback',
  description:
    'Save a structured report about missing sandbox packages, missing Nixre tools, or permission gates. Call once at the end of an environment audit. Do not edit the Dockerfile.',
  parameters: {
    type: 'object',
    properties: {
      missing_binaries: {
        type: 'array',
        items: { type: 'string' },
        description: 'CLIs not on PATH (e.g. rg, curl, jq)',
      },
      missing_packages: {
        type: 'array',
        items: { type: 'string' },
        description: 'apt/pip/npm packages that had to be installed or were unavailable',
      },
      missing_nixre_tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tools the agent expected (browser, MCP, etc.) that Nixre does not expose',
      },
      permission_gaps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Blocked by the repo access profile, not the image',
      },
      dockerfile_suggestions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Suggested apt packages or Dockerfile lines. Suggestions only.',
      },
      notes: { type: 'string', description: 'Short summary for operators' },
    },
    required: [],
  },
};

const FAIL_RE =
  /command not found|not found:|no such file or directory|permission denied|requires the '|EACCES|ENOENT/i;

export function collectToolFailures(messages) {
  const hits = [];
  for (const m of messages || []) {
    const tools = [];
    if (Array.isArray(m.parts)) {
      for (const p of m.parts) {
        if (p.type === 'tool' && p.tool) tools.push(p.tool);
      }
    }
    if (Array.isArray(m.toolCalls)) tools.push(...m.toolCalls);
    for (const t of tools) {
      const out = String(t.output || '');
      if (t.status === 'error' || FAIL_RE.test(out)) {
        hits.push({ name: t.name || 'tool', output: out.slice(0, 400) });
      }
    }
  }
  return hits.slice(-12);
}

function capList(v, n = 20) {
  if (!Array.isArray(v)) return [];
  return v
    .map(x => String(x || '').trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, n);
}

export function normalizeReport(args = {}) {
  return {
    missing_binaries: capList(args.missing_binaries),
    missing_packages: capList(args.missing_packages),
    missing_nixre_tools: capList(args.missing_nixre_tools),
    permission_gaps: capList(args.permission_gaps),
    dockerfile_suggestions: capList(args.dockerfile_suggestions),
    notes: String(args.notes || '').trim().slice(0, 4000),
  };
}

export function formatEnvAuditContext({ permissions = {}, tools = [], failures = [] } = {}) {
  const perms = {
    canRunBash: permissions.canRunBash !== false,
    canRunTests: permissions.canRunTests !== false,
    canSearchWeb: permissions.canSearchWeb === true,
    allowedPaths: permissions.allowedPaths || '(any)',
    blockedPaths: permissions.blockedPaths || '(none)',
  };
  const failLines = failures.length
    ? failures.map(f => `- ${f.name}: ${String(f.output).replace(/\s+/g, ' ').slice(0, 180)}`).join('\n')
    : '(none in this conversation)';
  return `<env_audit>
You are auditing the Nixre agent Docker sandbox and tool surface, not implementing product code.
The image is kept slim on purpose. Distinguish: missing binaries vs permission gates vs tools Nixre does not have.

1. If run_command is permitted, probe PATH (command -v git node python3 npm pip3 curl jq rg rustc docker; dpkg -l | head).
2. Compare against the recipe and recent failures below.
3. Call submit_env_feedback once with a structured report. Do not edit the Dockerfile or install packages as a "fix".
4. Summarize for the user in under 15 lines.

<sandbox_recipe>
${JSON.stringify(SANDBOX_IMAGE_RECIPE, null, 2)}
</sandbox_recipe>

<nixre_tools>
${(tools || []).join(', ')}
</nixre_tools>

<access_profile>
${JSON.stringify(perms, null, 2)}
</access_profile>

<recent_tool_failures>
${failLines}
</recent_tool_failures>
</env_audit>`;
}

function newId() {
  return `envfb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveEnvFeedback(pool, { userId, conversationId, repoPath, report }) {
  const normalized = normalizeReport(report);
  const id = newId();
  await pool.query(
    `INSERT INTO agent_env_feedback (id, user_id, conversation_id, repo_path, report)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [id, userId, conversationId || null, repoPath, JSON.stringify(normalized)],
  );
  return { id, saved: true, report: normalized };
}

export async function listEnvFeedback(pool, { userId, admin, limit = 50 }) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (admin) {
    const { rows } = await pool.query(
      `SELECT id, user_id, conversation_id, repo_path, report, created_at
         FROM agent_env_feedback ORDER BY created_at DESC LIMIT $1`,
      [lim],
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT id, user_id, conversation_id, repo_path, report, created_at
       FROM agent_env_feedback WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, lim],
  );
  return rows;
}
