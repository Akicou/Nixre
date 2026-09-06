// Error boundary — a crashing view must not take the whole app down with it.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../components/ErrorBoundary';

function Boom({ shouldThrow = true }: { shouldThrow?: boolean }) {
  if (shouldThrow) throw new Error('render exploded');
  return <p>recovered</p>;
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeTruthy();
  });

  it('shows a recovery card instead of unmounting the app', () => {
    // Suppress React's own error logging for the intentional throw.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary')).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText(/render exploded/)).toBeTruthy();
    spy.mockRestore();
  });

  it('reports the error through onError', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0].message).toBe('render exploded');
    spy.mockRestore();
  });

  it('recovers when Try again is pressed and the child no longer throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    const Toggle = () => <Boom shouldThrow={shouldThrow} />;

    render(
      <ErrorBoundary>
        <Toggle />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary')).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByTestId('error-boundary-retry'));

    expect(screen.getByText('recovered')).toBeTruthy();
    spy.mockRestore();
  });

  it('uses a custom fallback when provided', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={(err) => <p>custom: {err.message}</p>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/custom: render exploded/)).toBeTruthy();
    expect(screen.queryByTestId('error-boundary')).toBeNull();
    spy.mockRestore();
  });
});
