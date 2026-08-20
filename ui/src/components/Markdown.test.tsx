import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown, isMarkdownFile } from './Markdown';

describe('isMarkdownFile', () => {
  it('detects common markdown extensions', () => {
    expect(isMarkdownFile('README.md')).toBe(true);
    expect(isMarkdownFile('docs/guide.markdown')).toBe(true);
    expect(isMarkdownFile('note.MDX')).toBe(true);
    expect(isMarkdownFile('main.ts')).toBe(false);
    expect(isMarkdownFile('')).toBe(false);
  });
});

describe('Markdown', () => {
  it('renders headings, bold text, and links', () => {
    render(
      <Markdown content={'# Hello\n\nThis is **bold** and a [link](https://nixre.dev).'} />,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Hello' })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    const link = screen.getByRole('link', { name: 'link' });
    expect(link).toHaveAttribute('href', 'https://nixre.dev');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders fenced code blocks', () => {
    render(<Markdown content={'```\nconst x = 1;\n```'} />);
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
  });
});
