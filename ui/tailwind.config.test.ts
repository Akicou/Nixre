import { describe, it, expect } from 'vitest';
import resolveConfig from 'tailwindcss/resolveConfig';
// @ts-expect-error - plain JS config file
import tailwindConfig from './tailwind.config.js';

describe('tailwind config', () => {
  const resolved = resolveConfig(tailwindConfig as any);
  const colors = resolved.theme.colors as any;

  it('exposes feedback.error.bg/border/text used across the UI (Login, Register, Settings, NewRepo, NewSpace, Navbar, AdminView)', () => {
    expect(colors.feedback.error.bg).toBe('var(--color-feedback-error-bg)');
    expect(colors.feedback.error['bg-selected']).toBe('var(--color-feedback-error-bg-selected)');
    expect(colors.feedback.error.border).toBe('var(--color-feedback-error-border)');
    expect(colors.feedback.error.text).toBe('var(--color-feedback-error-text)');
  });

  it('exposes feedback.success.bg/border/text', () => {
    expect(colors.feedback.success.bg).toBe('var(--color-feedback-success-bg)');
    expect(colors.feedback.success.border).toBe('var(--color-feedback-success-border)');
    expect(colors.feedback.success.text).toBe('var(--color-feedback-success-text)');
  });

  it('exposes feedback.warning.bg/border/text', () => {
    expect(colors.feedback.warning.bg).toBe('var(--color-feedback-warning-bg)');
    expect(colors.feedback.warning.border).toBe('var(--color-feedback-warning-border)');
    expect(colors.feedback.warning.text).toBe('var(--color-feedback-warning-text)');
  });
});
