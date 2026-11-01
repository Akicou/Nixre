import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { HoverMarquee, MARQUEE_DELAY_MS } from '../components/HoverMarquee';

// jsdom has no layout: make the label 300px of text in a 100px box.
function fakeLayout(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth);
}

const row = (label = 'A very long conversation title that does not fit') => (
  <div data-marquee-host data-testid="row"><HoverMarquee>{label}</HoverMarquee></div>
);
const active = () => document.querySelector('[data-marquee-active]');

describe('HoverMarquee', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('starts scrolling only after the pointer has rested on the row for 200 ms', () => {
    fakeLayout(300, 100);
    render(row());
    fireEvent.mouseEnter(screen.getByTestId('row'));
    act(() => { vi.advanceTimersByTime(MARQUEE_DELAY_MS - 1); });
    expect(active()).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(active()).not.toBeNull();
    const moving = active()!.firstElementChild as HTMLElement;
    expect(moving.style.getPropertyValue('--mq-dist')).toBe('-200px');
    expect(moving.style.animation).toContain('hover-marquee');
  });

  it('stops and resets when the pointer leaves, and a quick pass never starts it', () => {
    fakeLayout(300, 100);
    render(row());
    fireEvent.mouseEnter(screen.getByTestId('row'));
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.mouseLeave(screen.getByTestId('row'));
    act(() => { vi.advanceTimersByTime(500); });
    expect(active()).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId('row'));
    act(() => { vi.advanceTimersByTime(MARQUEE_DELAY_MS); });
    expect(active()).not.toBeNull();
    fireEvent.mouseLeave(screen.getByTestId('row'));
    expect(active()).toBeNull();
  });

  it('never moves text that already fits', () => {
    fakeLayout(100, 100);
    render(row('Short'));
    fireEvent.mouseEnter(screen.getByTestId('row'));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(active()).toBeNull();
  });

  it('respects reduced motion', () => {
    fakeLayout(300, 100);
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
    render(row());
    fireEvent.mouseEnter(screen.getByTestId('row'));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(active()).toBeNull();
  });
});
