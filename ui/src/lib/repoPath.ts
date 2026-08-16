export type NodeType = 'blob' | 'tree';

const NON_SPACE_ROUTES = new Set(['new-repo', 'new-space', 'settings', 'admin', 'login', 'register']);

// Navbar renders outside the <Routes> tree, so it can't use useParams() to
// know which space is currently open - it has to read the URL itself.
export function currentSpaceFromPathname(pathname: string): string | null {
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first || NON_SPACE_ROUTES.has(first)) return null;
  return first;
}

// Whether the current /code view is showing a file (blob) or a directory
// (tree) is decided by an explicit `type` URL param set by the caller that
// navigated here (it already knows the TreeEntry's real type) rather than
// guessed from the path string, which breaks on extension-less files
// (LICENSE, Dockerfile, Makefile) and dotted directory names (v1.2/).
export function resolveNodeType(typeParam: string | null): NodeType {
  return typeParam === 'blob' ? 'blob' : 'tree';
}
