import { it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SourceCode } from './SourceCode';

it('highlights repository HTML without rendering its markup', () => {
  const { container } = render(<SourceCode filename="index.html" content={'<button onclick="alert(1)">Go</button>'} />);
  expect(container.querySelector('.hljs-name')).toHaveTextContent('button');
  expect(container.querySelector('button')).toBeNull();
});

it('keeps source containing Markdown fences inside a single code block', () => {
  const content = 'const template = `\n```\n# heading\n```\n`;';
  const { container } = render(<SourceCode filename="example.js" content={content} />);
  expect(container.querySelectorAll('pre')).toHaveLength(1);
  expect(container.querySelector('h1')).toBeNull();
  expect(container.querySelector('code')?.textContent).toBe(content + '\n');
});
