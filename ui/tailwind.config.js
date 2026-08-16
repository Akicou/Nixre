/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        surface: {
          base: 'var(--color-surface-base)',
          canvas: 'var(--color-surface-canvas)',
          subtle: 'var(--color-surface-subtle)',
          mid: 'var(--color-surface-mid)',
          strong: 'var(--color-surface-strong)',
          open: 'var(--color-surface-open)',
          merged: 'var(--color-surface-merged)',
          closed: 'var(--color-surface-closed)',
        },
        txt: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          tertiary: 'var(--color-text-tertiary)',
          open: 'var(--color-text-open)',
          merged: 'var(--color-text-merged)',
          closed: 'var(--color-text-closed)',
          brand: 'var(--color-text-brand)',
        },
        border: {
          subtle: 'var(--color-border-subtle)',
          mid: 'var(--color-border-mid)',
          strong: 'var(--color-border-strong)',
        },
        brand: {
          DEFAULT: 'var(--color-brand-bg)',
          hover: 'var(--color-brand-hover)',
        },
        feedback: {
          error: {
            bg: 'var(--color-feedback-error-bg)',
            'bg-selected': 'var(--color-feedback-error-bg-selected)',
            border: 'var(--color-feedback-error-border)',
            text: 'var(--color-feedback-error-text)',
          },
          success: {
            bg: 'var(--color-feedback-success-bg)',
            'bg-selected': 'var(--color-feedback-success-bg-selected)',
            border: 'var(--color-feedback-success-border)',
            text: 'var(--color-feedback-success-text)',
          },
          warning: {
            bg: 'var(--color-feedback-warning-bg)',
            border: 'var(--color-feedback-warning-border)',
            text: 'var(--color-feedback-warning-text)',
          },
        },
      },
      fontFamily: {
        sans: ['Booton', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      }
    },
  },
  plugins: [],
}
