import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { useOutsideClick } from './useOutsideClick';

function setup(active: boolean, onOutside: () => void) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ref = { current: el };
  renderHook(() => useOutsideClick(ref, onOutside, active));
  return el;
}

describe('useOutsideClick', () => {
  it('calls the handler when a mousedown happens outside the ref element', () => {
    const onOutside = vi.fn();
    setup(true, onOutside);

    fireEvent.mouseDown(document.body);

    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  it('does not call the handler when the click is inside the ref element', () => {
    const onOutside = vi.fn();
    const el = setup(true, onOutside);

    fireEvent.mouseDown(el);

    expect(onOutside).not.toHaveBeenCalled();
  });

  it('does nothing when inactive', () => {
    const onOutside = vi.fn();
    setup(false, onOutside);

    fireEvent.mouseDown(document.body);

    expect(onOutside).not.toHaveBeenCalled();
  });
});
