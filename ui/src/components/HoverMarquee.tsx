import React, { useEffect, useRef, useState } from 'react';

/** How long the pointer must rest on the row before long text starts to scroll. */
export const MARQUEE_DELAY_MS = 200;

/** Soft edges while the text moves, so it does not cut off abruptly. */
const FADE = 'linear-gradient(to right, transparent 0, #000 10px, #000 calc(100% - 14px), transparent 100%)';

/**
 * Truncated text that scrolls like a ticker while its row is hovered or focused.
 *
 * The host is the closest ancestor marked `data-marquee-host` (or the direct parent), so one row
 * hover moves its title without making the text itself the hover target. Text that fits never
 * moves, and `prefers-reduced-motion` keeps the plain ellipsis.
 */
export const HoverMarquee: React.FC<{ children: string; className?: string }> = ({ children, className = '' }) => {
  const clip = useRef<HTMLSpanElement>(null);
  const [run, setRun] = useState<{ dist: number; seconds: number } | null>(null);

  useEffect(() => {
    const el = clip.current;
    const host = el?.closest<HTMLElement>('[data-marquee-host]') ?? el?.parentElement;
    if (!el || !host) return;
    let timer: number | undefined;
    const stop = () => {
      window.clearTimeout(timer);
      setRun(null);
    };
    const start = () => {
      window.clearTimeout(timer);
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      timer = window.setTimeout(() => {
        const dist = el.scrollWidth - el.clientWidth;
        if (dist > 2) setRun({ dist, seconds: Math.max(3, dist / 40 + 1.5) });
      }, MARQUEE_DELAY_MS);
    };
    host.addEventListener('mouseenter', start);
    host.addEventListener('mouseleave', stop);
    host.addEventListener('focusin', start);
    host.addEventListener('focusout', stop);
    return () => {
      window.clearTimeout(timer);
      host.removeEventListener('mouseenter', start);
      host.removeEventListener('mouseleave', stop);
      host.removeEventListener('focusin', start);
      host.removeEventListener('focusout', stop);
    };
  }, []);

  // A new label starts from the beginning.
  useEffect(() => setRun(null), [children]);

  return (
    <span
      ref={clip}
      data-marquee-active={run ? 'true' : undefined}
      className={`block min-w-0 ${run ? 'overflow-hidden whitespace-nowrap' : 'truncate'} ${className}`}
      style={run ? { WebkitMaskImage: FADE, maskImage: FADE } : undefined}
    >
      {run ? (
        <span
          className="inline-block"
          style={{
            ['--mq-dist' as string]: `-${run.dist}px`,
            animation: `hover-marquee ${run.seconds}s ease-in-out infinite alternate`,
          }}
        >
          {children}
        </span>
      ) : (
        children
      )}
    </span>
  );
};
