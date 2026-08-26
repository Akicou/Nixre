// Workspace target helpers — the frontend mirror of backend
// src/lib/workspaces.js. A conversation's repoPath identifies one of:
//   "space/repo"        → Nixre hosted repository
//   "github/owner/repo" → github.com repository
//   "unrestricted"      → free-form scratch workspace (no repo)

export type WorkspaceKind = 'nixre' | 'github' | 'unrestricted';

export const UNRESTRICTED_PATH = 'unrestricted';

export function classifyWorkspacePath(path: string): WorkspaceKind {
  const p = String(path || '').trim();
  if (!p || p === UNRESTRICTED_PATH) return 'unrestricted';
  const parts = p.split('/').filter(Boolean);
  if (parts.length === 2) return 'nixre';
  if (parts.length === 3 && parts[0] === 'github') return 'github';
  return 'nixre';
}

/** Compact display label: owner/repo for GitHub targets, path otherwise. */
export function workspaceLabel(path: string): string {
  if (classifyWorkspacePath(path) === 'unrestricted') return 'Unrestricted';
  return path;
}
