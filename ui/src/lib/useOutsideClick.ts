import { useEffect, useRef } from 'react';

export function useOutsideClick(
  ref: React.RefObject<HTMLElement>,
  onOutside: () => void,
  active: boolean
) {
  useEffect(() => {
    if (!active) return;

    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutside();
      }
    };

    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [active, onOutside, ref]);
}
