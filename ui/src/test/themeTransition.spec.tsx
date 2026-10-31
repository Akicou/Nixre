import { describe, it, expect, vi, afterEach } from 'vitest';
import { withThemeWave } from '../lib/themeTransition';

afterEach(() => {
  delete (document as any).startViewTransition;
  vi.restoreAllMocks();
});

const button = () => document.body.appendChild(document.createElement('button'));

describe('withThemeWave', () => {
  it('applies the theme immediately when View Transitions are unavailable', () => {
    const apply = vi.fn();
    withThemeWave(button(), apply);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('applies the theme immediately when the user prefers reduced motion', () => {
    const start = vi.fn();
    (document as any).startViewTransition = start;
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const apply = vi.fn();
    withThemeWave(button(), apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('runs the swap inside the transition and reveals through a growing circle', async () => {
    const apply = vi.fn();
    const animate = vi.fn(() => ({ onfinish: null, oncancel: null }));
    (document.documentElement as any).animate = animate;
    (document as any).startViewTransition = (cb: () => void) => {
      cb();
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    };
    withThemeWave(button(), apply);
    await Promise.resolve(); await Promise.resolve();
    expect(apply).toHaveBeenCalledTimes(1);
    const [keyframes, opts] = animate.mock.calls[0] as any;
    expect(keyframes.clipPath[0]).toMatch(/^circle\(0px at /);
    expect(keyframes.clipPath[1]).toMatch(/^circle\(\d+(\.\d+)?px at /);
    expect(opts.pseudoElement).toBe('::view-transition-new(root)');
    delete (document.documentElement as any).animate;
  });
});
