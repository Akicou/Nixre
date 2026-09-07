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

it('contains wide tables in a keyboard-accessible scroll region', () => {
  const { container } = render(<Markdown content={'| Column |\n| --- |\n| value |'} />);
  const table = container.querySelector('table')!;
  expect(table.parentElement).toHaveAttribute('role', 'region');
  expect(table.parentElement).toHaveAttribute('tabindex', '0');
  expect(table.parentElement).toHaveClass('overflow-x-auto');
});

it('renders HTML examples as text without executing them', () => {
  const { container } = render(<Markdown content={'```html\n<script>alert(1)</script>\n```\n\n[unsafe](javascript:alert%281%29)'} />);
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('code')).toHaveTextContent('<script>alert(1)</script>');
  expect(container.querySelector('a')).not.toHaveAttribute('href', 'javascript:alert%281%29');
});

it('syntax highlights language-tagged code blocks', () => {
  const { container } = render(<Markdown content={'```js\nconst greeting = "hello";\n```'} />);
  expect(container.querySelector('.hljs-keyword')).toHaveTextContent('const');
  expect(container.querySelector('.hljs-string')).toHaveTextContent('"hello"');
});

it('keeps unknown languages, plain text, and partial streamed fences readable', () => {
  const { container, rerender } = render(<Markdown content={'```made-up\nhello <world>\n```'} />);
  expect(container.querySelector('code')).toHaveTextContent('hello <world>');
  rerender(<Markdown content={'```text\nconst a = 1;\n```'} />);
  expect(container.querySelector('.hljs-keyword')).toBeNull();
  rerender(<Markdown content={'```python\ndef hello():'} />);
  expect(container.querySelector('.hljs-keyword')).toHaveTextContent('def');
});
