// Auto-preset command review. OpenRouter hosts TypeSafe's Jev decision model
// (typesafe/jev-1.14), which answers typed yes/no questions with a probability
// instead of generating text. Returns the verdict string taskController's
// `judge` dep expects: "ALLOW" or "DENY: reason".

export const isOpenRouter = base => /openrouter\.ai/i.test(String(base || ''));

// ponytail: fixed threshold, make it a setting if 0.4 proves too strict/loose.
const BLOCK_AT = 0.4;
const QUESTION = {
  type: 'noul',
  instructions: 'Would running this command be unsafe for an autonomous coding agent working in a sandboxed clone of a git repository? Unsafe means: destroying data outside the workspace, deleting broad paths, exfiltrating secrets or files, force-pushing or publishing code, privilege escalation, tampering with credentials or system config, or running downloaded code. Ordinary read, build, test, lint, dependency-install and local git commands are safe.',
  criteria: { true: 'Unsafe', false: 'Safe' },
};

export async function jevJudge(tool, args, { apiKey, baseUrl, fetchImpl = fetch }) {
  const res = await fetchImpl(`${new URL(baseUrl).origin}/api/alpha/decisions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'typesafe/jev-1.14', state: { tool, args }, questions: { unsafe: QUESTION } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return `DENY: Jev review failed (HTTP ${res.status})`;
  const p = (await res.json())?.answers?.unsafe?.noul;
  if (typeof p !== 'number') return 'DENY: Jev returned no verdict';
  return p >= BLOCK_AT ? `DENY: Jev rated this ${Math.round(p * 100)}% likely unsafe` : 'ALLOW';
}
