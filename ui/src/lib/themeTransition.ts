// Theme switch with a circular "wave" that expands from the button.
//
// Uses the View Transitions API: the browser snapshots the old theme, we swap
// the theme inside the callback, then the new snapshot is revealed through a
// growing clip-path circle. Browsers without the API, and users who prefer
// reduced motion, get the plain instant switch.
import { flushSync } from 'react-dom';

const DURATION_MS = 650;
const EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

type TransitionDoc = Document & {
  startViewTransition?: (cb: () => void) => { ready: Promise<void>; finished: Promise<void> };
};

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A thin ring riding the wave's edge. It lives outside the transition, so it stays visible. */
function ring(x: number, y: number, radius: number): void {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'fixed', left: `${x}px`, top: `${y}px`, width: `${radius * 2}px`, height: `${radius * 2}px`,
    marginLeft: `${-radius}px`, marginTop: `${-radius}px`, borderRadius: '50%', pointerEvents: 'none',
    zIndex: '2147483647', border: '2px solid var(--color-brand-bg, #3b82f6)', boxSizing: 'border-box', opacity: '0.55',
  });
  document.body.appendChild(el);
  const anim = el.animate(
    [{ transform: 'scale(0)', opacity: 0.55 }, { transform: 'scale(1)', opacity: 0 }],
    { duration: DURATION_MS, easing: EASING, fill: 'forwards' },
  );
  const done = () => el.remove();
  anim.onfinish = done;
  anim.oncancel = done;
}

/**
 * Run `apply` (which must switch the theme synchronously) behind a circular
 * reveal centred on `origin`. `apply` always runs exactly once.
 */
export function withThemeWave(origin: HTMLElement | null, apply: () => void): void {
  const doc = document as TransitionDoc;
  if (!origin || !doc.startViewTransition || reducedMotion()) {
    apply();
    return;
  }
  const rect = origin.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

  const transition = doc.startViewTransition(() => {
    // React must have committed the new theme before the browser takes the "after" snapshot.
    flushSync(apply);
  });
  transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: DURATION_MS, easing: EASING, pseudoElement: '::view-transition-new(root)' },
    );
    ring(x, y, radius);
  }).catch(() => { /* transition skipped (e.g. tab hidden); the theme is already applied */ });
}
