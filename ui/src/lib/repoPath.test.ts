import { describe, it, expect } from 'vitest';
import { resolveNodeType, currentSpaceFromPathname } from './repoPath';

describe('resolveNodeType', () => {
  it('treats an explicit type=blob param as a file', () => {
    expect(resolveNodeType('blob')).toBe('blob');
  });

  it('treats an explicit type=tree param as a directory', () => {
    expect(resolveNodeType('tree')).toBe('tree');
  });

  it('defaults to tree when no type param is present (e.g. repo root)', () => {
    expect(resolveNodeType(null)).toBe('tree');
  });

  it('does not guess from dots in the path (LICENSE, Dockerfile, v1.2/ must not be misdetected)', () => {
    // The old buggy heuristic checked currentPath.includes('.'); this helper
    // never looks at the path at all, only the explicit type param.
    expect(resolveNodeType('tree')).toBe('tree');
  });
});

describe('currentSpaceFromPathname', () => {
  it('extracts the space uid from a /:space route', () => {
    expect(currentSpaceFromPathname('/Nayhein')).toBe('Nayhein');
  });

  it('extracts the space uid from a /:space/:repo route', () => {
    expect(currentSpaceFromPathname('/Nayhein/demo-project')).toBe('Nayhein');
  });

  it('returns null for app routes that are not a space (dashboard, settings, admin)', () => {
    expect(currentSpaceFromPathname('/')).toBeNull();
    expect(currentSpaceFromPathname('/settings')).toBeNull();
    expect(currentSpaceFromPathname('/new-repo')).toBeNull();
    expect(currentSpaceFromPathname('/new-space')).toBeNull();
    expect(currentSpaceFromPathname('/admin')).toBeNull();
    expect(currentSpaceFromPathname('/login')).toBeNull();
    expect(currentSpaceFromPathname('/register')).toBeNull();
  });
});
