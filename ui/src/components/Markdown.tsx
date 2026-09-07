import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface MarkdownProps {
  content: string;
  className?: string;
}

export const Markdown: React.FC<MarkdownProps> = ({ content, className = '' }) => {
  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { plainText: ['text', 'txt', 'plaintext'], aliases: { javascript: ['jsx'], typescript: ['tsx'] } }]]}
        components={{
          table: ({ children }) => (
            <div className="max-w-full overflow-x-auto" role="region" aria-label="Table" tabIndex={0}>
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

export function isMarkdownFile(name: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(name || '');
}
