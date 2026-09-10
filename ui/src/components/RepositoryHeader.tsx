import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, Copy, Download, GitBranch, GitPullRequest } from 'lucide-react';
import type { Repository } from '../lib/api';
import { useOutsideClick } from '../lib/useOutsideClick';
import { Avatar } from './Avatar';

export function RepositoryHeader({ repo, space, branchCount }: { repo: Repository; space: string; branchCount: number }) {
  const [open, setOpen] = useState(false);
  const [protocol, setProtocol] = useState<'http' | 'ssh'>('http');
  const [copied, setCopied] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useOutsideClick(menu, () => setOpen(false), open);
  const url = protocol === 'http' ? `${window.location.origin}/git/${space}/${repo.uid}.git`
    : `ssh://git@${window.location.hostname}:3022/${space}/${repo.uid}.git`;
  return <header className="py-6 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <Avatar name={space} url={`/api/v1/avatars/space/${encodeURIComponent(space)}`} size={40} shape="square" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <Link to={`/${space}`} className="text-sm text-txt-secondary hover:text-brand">{space}</Link>
            <span className="text-txt-tertiary">/</span>
            <h1 className="text-xl font-semibold font-mono text-txt-primary break-all">{repo.uid}</h1>
            <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border border-border-subtle text-txt-tertiary">{repo.is_public ? 'Public' : 'Private'}</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-txt-tertiary mt-1">
            <span className="inline-flex items-center gap-1"><GitBranch className="w-3 h-3" />{branchCount} {branchCount === 1 ? 'branch' : 'branches'} · default {repo.default_branch}</span>
            <span className="inline-flex items-center gap-1"><GitPullRequest className="w-3 h-3" />{repo.num_open_pulls} open pull {repo.num_open_pulls === 1 ? 'request' : 'requests'}</span>
          </div>
        </div>
      </div>
      <div ref={menu} className="relative shrink-0">
        <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); setCopied(false); }} className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border-subtle bg-surface-canvas text-xs font-medium text-txt-primary hover:bg-surface-subtle">
          <Download className="w-3.5 h-3.5" />Clone Repo<ChevronDown className="w-3 h-3" />
        </button>
        {open && <div className="absolute right-0 mt-2 w-80 max-w-[85vw] rounded-md bg-surface-canvas border border-border-mid shadow-lg p-3 z-50 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-txt-primary">Clone with Git</span>
            <div className="flex gap-2">{(['http', 'ssh'] as const).map(value => <button key={value} type="button" aria-pressed={protocol === value} onClick={() => { setProtocol(value); setCopied(false); }} className={protocol === value ? 'text-brand font-semibold' : 'text-txt-secondary'}>{value === 'http' ? 'HTTPS' : 'SSH'}</button>)}</div>
          </div>
          <div className="flex items-center gap-2 p-2 border border-border-subtle rounded bg-surface-base">
            <input aria-label="Clone URL" value={url} readOnly className="w-full min-w-0 bg-transparent text-xs font-mono text-txt-primary" />
            <button type="button" title="Copy clone URL" onClick={() => { void navigator.clipboard.writeText(url).then(() => setCopied(true)); }} className="text-txt-secondary hover:text-brand">{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}</button>
          </div>
          <p className="text-[11px] text-txt-secondary">{protocol === 'ssh' ? <>Register your SSH key in <Link to="/settings" className="text-brand underline">Settings</Link>. Port 3022 must be reachable.</> : repo.is_public ? 'Anyone can clone this public repository.' : <>Use your username and an access token as the password. Create one in <Link to="/settings" className="text-brand underline">Settings → Access Tokens</Link>.</>}</p>
        </div>}
      </div>
    </div>
    {repo.description && <p className="text-sm text-txt-secondary leading-relaxed whitespace-pre-wrap max-w-4xl">{repo.description}</p>}
  </header>;
}
