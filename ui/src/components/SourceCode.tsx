import React from 'react';
import { Markdown } from './Markdown';

const languages: Record<string, string> = {
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'tsx', py: 'python', rb: 'ruby', rs: 'rust',
  html: 'xml', htm: 'xml', svg: 'xml', sh: 'bash', cs: 'csharp',
  yml: 'yaml', h: 'c', hpp: 'cpp', cc: 'cpp', kt: 'kotlin',
};

/** Use a fence longer than any source backticks so source stays inert code. */
export const SourceCode: React.FC<{ content: string; filename: string }> = ({ content, filename }) => {
  const name = filename.split('/').pop()?.toLowerCase() || '';
  const extension = name.includes('.') ? name.split('.').pop()! : '';
  const language = name === 'dockerfile' ? 'dockerfile'
    : name === 'makefile' ? 'makefile'
    : languages[extension] || (/^[a-z0-9]+$/.test(extension) ? extension : 'text');
  let fenceLength = 3;
  for (const run of content.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, run[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  return <Markdown content={`${fence}${language}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`} />;
};
