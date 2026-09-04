import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import {
  GitBranch,
  GitCommit,
  GitPullRequest,
  File,
  Folder,
  History,
  Copy,
  Check,
  ChevronDown,
  Download,
  Plus,
  Pencil,
  ArrowLeft,
  FileCode,
  FolderGit2,
  Rocket,
  Settings
} from 'lucide-react';
import { api, Repository, TreeEntry, Commit, Branch, PullRequest, CommitDetail } from '../lib/api';
import { resolveNodeType } from '../lib/repoPath';
import { useOutsideClick } from '../lib/useOutsideClick';
import { PullRequestForm } from '../components/PullRequestForm';
import { PullRequestDetail } from '../components/PullRequestDetail';
import { RepoSettingsPanel } from '../components/RepoSettingsPanel';
import { FileEditor } from '../components/FileEditor';
import { Markdown, isMarkdownFile } from '../components/Markdown';
import { Avatar } from '../components/Avatar';
import { DeploymentsSection } from '../pages/DeploymentsPage';
export const RepoView: React.FC = () => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const repoPath = `${space}/${repoUid}`;

  const activeTab = searchParams.get('tab') || 'code';
  // Deployments live inside the code view as a collapsible section. Deep-link
  // with ?deploys=1; the legacy ?tab=deployments also opens it.
  const deploysOpen = searchParams.get('deploys') === '1' || activeTab === 'deployments';
  const setDeploysOpen = (open: boolean) => setSearchParams(prev => {
    const next = new URLSearchParams(prev);
    if (open) next.set('deploys', '1');
    else next.delete('deploys');
    if (next.get('tab') === 'deployments') next.delete('tab');
    return next;
  });
  const currentBranch = searchParams.get('branch') || 'main';
  const currentPath = searchParams.get('path') || '';
  const currentNodeType = resolveNodeType(searchParams.get('type'));
  const prParam = searchParams.get('pr');
  const commitParam = searchParams.get('commit');
  const selectedPrNumber: number | 'new' | null = prParam === 'new' ? 'new' : prParam ? Number(prParam) : null;

  const [repo, setRepo] = useState<Repository | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([]);
  const [fileBlob, setFileBlob] = useState<{ content: string; name: string; size: number } | null>(null);
  const [readmeContent, setReadmeContent] = useState<string | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [latestCommit, setLatestCommit] = useState<Commit | null>(null);
  const [pullRequests, setPullRequests] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [cloneDropdownOpen, setCloneDropdownOpen] = useState(false);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cloneProtocol, setCloneProtocol] = useState<'http' | 'ssh'>('http');
  const [editor, setEditor] = useState<{ mode: 'edit' | 'create'; path: string; content: string } | null>(null);
  const cloneMenuRef = useRef<HTMLDivElement>(null);
  const branchMenuRef = useRef<HTMLDivElement>(null);

  useOutsideClick(cloneMenuRef, () => setCloneDropdownOpen(false), cloneDropdownOpen);
  useOutsideClick(branchMenuRef, () => setBranchDropdownOpen(false), branchDropdownOpen);

  // Load Repo Base Data
  useEffect(() => {
    if (!space || !repoUid) return;
    setLoading(true);
    api.getRepo(repoPath)
      .then(r => {
        setRepo(r);
        return api.getBranches(repoPath);
      })
      .then(b => {
        setBranches(b);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load repository');
        setLoading(false);
      });
  }, [repoPath]);

  // Load Code / Tree / Blob
  useEffect(() => {
    if (!repo) return;

    if (activeTab === 'code') {
      // Latest commit for the current path (repo/folder/file) — the
      // "who made this" line GitHub shows under the file list.
      api.getCommits(repoPath, currentBranch, 1, 1, currentPath || undefined)
        .then(res => setLatestCommit(res.commits[0] || null))
        .catch(() => setLatestCommit(null));

      if (currentNodeType === 'blob') {
        // Fetch Blob
        api.getRawBlob(repoPath, currentBranch, currentPath)
          .then(blob => {
            setFileBlob(blob);
            setTreeEntries([]);
          })
          .catch(() => setFileBlob(null));
      } else {
        // Fetch Tree
        setFileBlob(null);
        api.getTree(repoPath, currentBranch, currentPath)
          .then(res => {
            setTreeEntries(res.entries);
            // Check for README
            const readmeEntry = res.entries.find(e => e.name.toLowerCase() === 'readme.md');
            if (readmeEntry) {
              const rPath = currentPath ? `${currentPath}/${readmeEntry.name}` : readmeEntry.name;
              api.getRawBlob(repoPath, currentBranch, rPath).then(b => setReadmeContent(b.content)).catch(() => {});
            } else {
              setReadmeContent(null);
            }
          })
          .catch(() => setTreeEntries([]));
      }
    } else if (activeTab === 'commits') {
      if (commitParam) {
        // Commit detail view
        setCommitDetail(null);
        api.getCommit(repoPath, commitParam)
          .then(d => setCommitDetail(d))
          .catch(() => setCommitDetail(null));
      } else {
        // Commit list, optionally filtered to a file/folder (History).
        setCommitDetail(null);
        api.getCommits(repoPath, currentBranch, 1, 50, currentPath || undefined)
          .then(res => setCommits(res.commits))
          .catch(() => setCommits([]));
      }
    } else if (activeTab === 'pulls') {
      api.listPullRequests(repoPath)
        .then(prs => setPullRequests(prs))
        .catch(() => setPullRequests([]));
    }
  }, [repo, activeTab, currentBranch, currentPath, currentNodeType, commitParam]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getHttpCloneUrl = () => {
    return `${window.location.origin}/git/${repoPath}.git`;
  };

  const getSshCloneUrl = () => {
    return `ssh://git@${window.location.hostname}:3022/${repoPath}.git`;
  };

  const goToCommit = (sha: string) => setSearchParams({ tab: 'commits', branch: currentBranch, commit: sha });
  const goToPathHistory = (path: string) => setSearchParams({ tab: 'commits', branch: currentBranch, path });

  const authorLink = (c: Commit) => {
    const actor = c.author;
    const name = actor.display_name || actor.identity.name;
    if (actor.linked && actor.uid) {
      return <Link to={`/${actor.uid}`} className="text-txt-brand hover:underline">{name}</Link>;
    }
    return <span>{name}</span>;
  };

  if (loading && !repo) {
    return <div className="max-w-7xl mx-auto px-4 py-16 text-center text-sm text-txt-tertiary">Loading repository...</div>;
  }

  if (error || !repo) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center space-y-4">
        <h2 className="text-lg font-bold text-txt-primary">Repository not found</h2>
        <p className="text-sm text-txt-secondary">{error || 'Could not find repository.'}</p>
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-txt-brand hover:underline">
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Dashboard</span>
        </Link>
      </div>
    );
  }

  const pathParts = currentPath ? currentPath.split('/').filter(Boolean) : [];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 w-full min-w-0">
      {/* Tabs — same pattern as user/org profile views */}
      <nav className="border-b border-border-subtle flex items-end gap-1 -mb-px overflow-x-auto">
        <button
          onClick={() => { setSearchParams({ tab: 'code', branch: currentBranch, type: 'tree' }); }}
          className={`px-4 py-3 text-sm font-medium border-b-2 transition shrink-0 inline-flex items-center gap-2 ${
            activeTab === 'code' ? 'border-brand text-txt-primary' : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          <FileCode className="w-4 h-4" />
          <span>Code</span>
        </button>

        <button
          onClick={() => { setSearchParams({ tab: 'commits', branch: currentBranch }); }}
          className={`px-4 py-3 text-sm font-medium border-b-2 transition shrink-0 inline-flex items-center gap-2 ${
            activeTab === 'commits' ? 'border-brand text-txt-primary' : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          <GitCommit className="w-4 h-4" />
          <span>Commits</span>
        </button>

        <button
          onClick={() => { setSearchParams({ tab: 'pulls' }); }}
          className={`px-4 py-3 text-sm font-medium border-b-2 transition shrink-0 inline-flex items-center gap-2 ${
            activeTab === 'pulls' ? 'border-brand text-txt-primary' : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          <GitPullRequest className="w-4 h-4" />
          <span>Pull Requests</span>
          {repo.num_open_pulls > 0 && (
            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded-full bg-surface-open text-txt-open">
              {repo.num_open_pulls}
            </span>
          )}
        </button>

        <button
          onClick={() => { setSearchParams({ tab: 'branches' }); }}
          className={`px-4 py-3 text-sm font-medium border-b-2 transition shrink-0 inline-flex items-center gap-2 ${
            activeTab === 'branches' ? 'border-brand text-txt-primary' : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          <GitBranch className="w-4 h-4" />
          <span>Branches</span>
          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded-full bg-surface-subtle text-txt-tertiary">
            {branches.length}
          </span>
        </button>

        <button
          onClick={() => { setSearchParams({ tab: 'settings' }); }}
          className={`px-4 py-3 text-sm font-medium border-b-2 transition shrink-0 inline-flex items-center gap-2 ${
            activeTab === 'settings' ? 'border-brand text-txt-primary' : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          <Settings className="w-4 h-4" />
          <span>Settings</span>
        </button>
      </nav>

      <div className="py-6 grid grid-cols-1 lg:grid-cols-[296px_minmax(0,1fr)] gap-8">
        {/* Sidebar — mirrors the profile layout */}
        <aside className="min-w-0 space-y-4">
          <div className="relative w-20 h-20 lg:w-[296px] lg:h-[296px]">
            <Avatar
              name={space}
              url={`/api/v1/avatars/space/${encodeURIComponent(space)}`}
              fill
              shape="square"
            />
            <div className="absolute -bottom-2 -right-2 p-2.5 rounded-xl bg-surface-canvas border border-border-subtle">
              <FolderGit2 className="w-5 h-5 text-txt-tertiary" />
            </div>
          </div>

          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-bold text-txt-primary leading-tight break-words font-mono">{repo.uid}</h1>
            <Link to={`/${space}`} className="text-lg text-txt-tertiary leading-tight hover:text-txt-brand transition break-words">
              {space}
            </Link>
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary">
                {repo.is_public ? 'Public' : 'Private'}
              </span>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary">
                Repository
              </span>
            </div>
          </div>

          {repo.description && (
            <p className="text-sm text-txt-primary whitespace-pre-wrap">{repo.description}</p>
          )}

        {/* Clone Button & Dropdown */}
        <div className="relative" ref={cloneMenuRef}>
          <button
            onClick={() => setCloneDropdownOpen(!cloneDropdownOpen)}
            className="flex items-center justify-center gap-2 w-full px-3 py-1.5 rounded-md bg-brand text-white hover:bg-brand-hover text-xs font-medium transition shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Clone Repo</span>
            <ChevronDown className="w-3.5 h-3.5 opacity-80" />
          </button>

          {cloneDropdownOpen && (
            <div className="absolute left-0 mt-2 w-80 max-w-[85vw] rounded-md bg-surface-canvas border border-border-mid shadow-xl p-3 z-50 animate-pop">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-txt-primary">Clone with Git</span>
                <div className="flex items-center rounded border border-border-subtle bg-surface-base p-0.5 text-[11px] font-mono">
                  <button
                    onClick={() => setCloneProtocol('http')}
                    className={`px-2 py-0.5 rounded ${cloneProtocol === 'http' ? 'bg-brand text-white' : 'text-txt-secondary'}`}
                  >
                    HTTPS
                  </button>
                  <button
                    onClick={() => setCloneProtocol('ssh')}
                    className={`px-2 py-0.5 rounded ${cloneProtocol === 'ssh' ? 'bg-brand text-white' : 'text-txt-secondary'}`}
                  >
                    SSH
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-1.5 p-1.5 rounded bg-surface-base border border-border-subtle">
                <input
                  type="text"
                  readOnly
                  value={cloneProtocol === 'http' ? getHttpCloneUrl() : getSshCloneUrl()}
                  className="w-full bg-transparent text-xs font-mono text-txt-primary outline-none truncate"
                />
                <button
                  onClick={() => copyToClipboard(cloneProtocol === 'http' ? getHttpCloneUrl() : getSshCloneUrl())}
                  className="p-1 rounded hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition shrink-0"
                  title="Copy to clipboard"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-txt-open" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>

              {cloneProtocol === 'http' ? (
                !repo.is_public ? (
                  <p className="text-[11px] leading-relaxed text-txt-tertiary mt-2">
                    When prompted, log in with your username and an{' '}
                    <span className="text-txt-secondary font-medium">access token</span> as the password — account
                    passwords are not accepted for git. Create one in{' '}
                    <a href="/settings" className="text-brand hover:underline">Settings → Access Tokens</a>.
                  </p>
                ) : (
                  <p className="text-[11px] leading-relaxed text-txt-tertiary mt-2">
                    This repository is public — anyone can clone it without credentials.
                  </p>
                )
              ) : (
                <p className="text-[11px] leading-relaxed text-txt-tertiary mt-2">
                  Requires an SSH public key registered in{' '}
                  <a href="/settings" className="text-brand hover:underline">Settings → SSH Keys</a>.
                  Port 3022 must be reachable.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Meta */}
        <div className="space-y-1.5 pt-1 text-xs text-txt-tertiary">
          <div className="flex items-center gap-2">
            <GitBranch className="w-3.5 h-3.5 shrink-0" />
            <span>default branch <span className="font-mono text-txt-secondary">{repo.default_branch}</span></span>
          </div>
          <div className="flex items-center gap-2">
            <GitPullRequest className="w-3.5 h-3.5 shrink-0" />
            <span>{repo.num_open_pulls} open pull request{repo.num_open_pulls === 1 ? '' : 's'}</span>
          </div>
          <div className="flex items-center gap-2">
            <FolderGit2 className="w-3.5 h-3.5 shrink-0" />
            <span>{branches.length} branch{branches.length === 1 ? '' : 'es'}</span>
          </div>
          <button
            type="button"
            onClick={() => setDeploysOpen(!deploysOpen)}
            data-testid="deployments-sidebar-toggle"
            className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 -mx-2 text-left transition ${
              deploysOpen
                ? 'bg-brand/10 text-brand'
                : 'text-txt-tertiary hover:text-txt-primary hover:bg-surface-subtle'
            }`}
          >
            <Rocket className="w-3.5 h-3.5 shrink-0" />
            <span className={deploysOpen ? 'font-medium' : ''}>Deployments</span>
            <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${deploysOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </aside>

      {/* Content column */}
      <div className="min-w-0 space-y-6">
      {/* Deployments — embedded section, toggled from the sidebar; renders at
          the top of the content column when open */}
      {deploysOpen && <DeploymentsSection onCollapse={() => setDeploysOpen(false)} />}

      {/* TAB CONTENT: CODE */}
      {activeTab === 'code' && (
        <div className="space-y-6">
          {/* Branch & Path Bar */}
          <div className="flex items-center justify-between gap-4 min-w-0">
            <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
              {/* Branch Picker */}
              <div className="relative" ref={branchMenuRef}>
                <button
                  onClick={() => setBranchDropdownOpen(!branchDropdownOpen)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-canvas border border-border-subtle text-xs font-mono font-medium text-txt-primary hover:bg-surface-subtle transition"
                >
                  <GitBranch className="w-3.5 h-3.5 text-txt-tertiary" />
                  <span>{currentBranch}</span>
                  <ChevronDown className="w-3 h-3 opacity-60 ml-1" />
                </button>

                {branchDropdownOpen && (
                  <div className="absolute left-0 mt-1.5 w-48 rounded-md bg-surface-canvas border border-border-mid shadow-lg py-1 z-50">
                    <div className="px-3 py-1 text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider">
                      Branches
                    </div>
                    {branches.map(b => (
                      <button
                        key={b.name}
                        onClick={() => {
                          setSearchParams({ tab: 'code', branch: b.name, type: 'tree' });
                          setBranchDropdownOpen(false);
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs font-mono text-txt-primary hover:bg-surface-subtle transition flex items-center justify-between"
                      >
                        <span className="truncate">{b.name}</span>
                        {b.name === currentBranch && <Check className="w-3.5 h-3.5 text-brand" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Breadcrumb Path */}
              <div className="flex items-center gap-1.5 text-xs font-mono text-txt-secondary min-w-0 overflow-x-auto flex-nowrap scrollbar-thin max-w-full">
                <button
                  onClick={() => setSearchParams({ tab: 'code', branch: currentBranch, type: 'tree' })}
                  className="hover:text-txt-brand transition"
                >
                  {repo.uid}
                </button>
                {pathParts.map((part, index) => {
                  const partPath = pathParts.slice(0, index + 1).join('/');
                  return (
                    <React.Fragment key={partPath}>
                      <span className="text-txt-tertiary">/</span>
                      <button
                        onClick={() => setSearchParams({ tab: 'code', branch: currentBranch, path: partPath, type: 'tree' })}
                        className={`hover:text-txt-brand transition ${index === pathParts.length - 1 ? 'font-semibold text-txt-primary' : ''}`}
                      >
                        {part}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
            {repo.can_write && currentNodeType !== 'blob' && (
              <button
                type="button"
                onClick={() => setEditor({
                  mode: 'create',
                  path: currentPath ? `${currentPath}/` : '',
                  content: '',
                })}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-canvas border border-border-subtle text-xs font-medium text-txt-primary hover:bg-surface-subtle transition shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Add file
              </button>
            )}
          </div>

          {/* Latest commit line — who made the most recent change here */}
          {latestCommit && (
            <div className="flex items-center gap-2 text-xs text-txt-tertiary font-mono">
              <GitCommit className="w-3.5 h-3.5 text-brand shrink-0" />
              <button
                onClick={() => goToCommit(latestCommit.sha)}
                className="text-txt-brand hover:underline shrink-0"
              >
                {latestCommit.sha.slice(0, 7)}
              </button>
              <span className="truncate min-w-0">{latestCommit.title}</span>
              <span className="shrink-0">· {latestCommit.author.display_name || latestCommit.author.identity.name}</span>
            </div>
          )}

          {/* If Single File Blob is active */}
          {editor ? (
            <FileEditor
              repoPath={repoPath}
              branch={currentBranch}
              path={editor.path}
              initialContent={editor.content}
              mode={editor.mode}
              baseSha={latestCommit?.sha}
              onCancel={() => setEditor(null)}
              onCommitted={({ branch, path }) => {
                setEditor(null);
                setSearchParams({ tab: 'code', branch, path, type: 'blob' });
              }}
            />
          ) : fileBlob ? (
            <div className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden">
              <div className="p-3 bg-surface-base border-b border-border-subtle flex items-center justify-between gap-2 text-xs font-mono min-w-0">
                <div className="flex items-center gap-2 text-txt-primary font-semibold min-w-0">
                  <File className="w-4 h-4 text-brand shrink-0" />
                  <span className="truncate">{fileBlob.name}</span>
                  <span className="text-txt-tertiary font-normal shrink-0">({fileBlob.size} bytes)</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => goToPathHistory(currentPath)}
                    className="p-1 rounded hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
                    title="History of this file"
                  >
                    <History className="w-3.5 h-3.5" />
                  </button>
                    <button
                      onClick={() => copyToClipboard(fileBlob.content)}
                      className="p-1 rounded hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
                      title="Copy raw file"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-txt-open" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    {repo.can_write && (
                      <button
                        type="button"
                        onClick={() => setEditor({ mode: 'edit', path: currentPath, content: fileBlob.content })}
                        className="p-1 rounded hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
                        title="Edit this file"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
              </div>
              {isMarkdownFile(fileBlob.name) ? (
                <div className="p-6">
                  <Markdown content={fileBlob.content} />
                </div>
              ) : (
                <div className="p-4 overflow-x-auto font-mono text-xs text-txt-primary leading-relaxed bg-surface-base/30">
                  <pre><code>{fileBlob.content}</code></pre>
                </div>
              )}
            </div>
          ) : (
            /* File Tree Table */
            <div className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden">
              <table className="w-full text-left text-xs font-mono divide-y divide-border-subtle">
                <thead className="bg-surface-base text-txt-tertiary">
                  <tr>
                    <th className="py-2.5 px-4 font-normal">Name</th>
                    <th className="py-2.5 px-4 font-normal text-right">Commit / SHA</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {currentPath && (
                    <tr
                      onClick={() => {
                        const parentPath = pathParts.slice(0, -1).join('/');
                        setSearchParams({ tab: 'code', branch: currentBranch, path: parentPath, type: 'tree' });
                      }}
                      className="hover:bg-surface-subtle/50 cursor-pointer transition"
                    >
                      <td className="py-2 px-4 flex items-center gap-2 text-txt-brand">
                        <Folder className="w-3.5 h-3.5 text-brand" />
                        <span>..</span>
                      </td>
                      <td className="py-2 px-4 text-right text-txt-tertiary"></td>
                    </tr>
                  )}
                  {treeEntries.map(entry => {
                    const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
                    return (
                      <tr
                        key={entry.name}
                        onClick={() => {
                          setSearchParams({ tab: 'code', branch: currentBranch, path: nextPath, type: entry.type });
                        }}
                        className="hover:bg-surface-subtle/50 cursor-pointer transition group"
                      >
                        <td className="py-2.5 px-4 flex items-center gap-2.5">
                          {entry.type === 'tree' ? (
                            <Folder className="w-4 h-4 text-brand shrink-0" />
                          ) : (
                            <File className="w-4 h-4 text-txt-tertiary shrink-0" />
                          )}
                          <span className={`hover:underline ${entry.type === 'tree' ? 'font-medium text-txt-primary' : 'text-txt-secondary'}`}>
                            {entry.name}
                          </span>
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              goToPathHistory(nextPath);
                            }}
                            className="ml-2 p-1 rounded hover:bg-surface-subtle text-txt-tertiary hover:text-txt-primary transition opacity-0 group-hover:opacity-100"
                            title="History of this path"
                          >
                            <History className="w-3.5 h-3.5" />
                          </button>
                        </td>
                        <td className="py-2.5 px-4 text-right text-txt-tertiary font-mono">
                          {entry.sha.slice(0, 7)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* README Rendered Box */}
          {readmeContent && !fileBlob && !editor && (
            <div className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden mt-6">
              <div className="p-3 bg-surface-base border-b border-border-subtle flex items-center gap-2 text-xs font-mono font-semibold text-txt-primary">
                <File className="w-4 h-4 text-brand" />
                <span>README.md</span>
              </div>
              <div className="p-6">
                <Markdown content={readmeContent} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB CONTENT: COMMITS */}
      {activeTab === 'commits' && (
        commitParam && commitDetail ? (
          <CommitDetailView
            detail={commitDetail}
            onBack={() => setSearchParams({ tab: 'commits', branch: currentBranch })}
          />
        ) : (
          <div className="space-y-4">
            {currentPath && (
              <div className="flex items-center justify-between gap-3 border border-border-subtle rounded-md bg-surface-base px-3 py-2 text-xs font-mono">
                <span className="flex items-center gap-2 text-txt-secondary min-w-0">
                  <History className="w-3.5 h-3.5 text-brand shrink-0" />
                  <span className="truncate">History for <span className="text-txt-primary font-semibold">{currentPath}</span></span>
                </span>
                <button
                  onClick={() => setSearchParams({ tab: 'commits', branch: currentBranch })}
                  className="text-txt-brand hover:underline shrink-0"
                >
                  Clear filter
                </button>
              </div>
            )}

            <div className="border border-border-subtle rounded-lg bg-surface-canvas divide-y divide-border-subtle overflow-hidden">
              {commits.length === 0 ? (
                <div className="p-8 text-center text-xs text-txt-tertiary font-mono">No commits found for this {currentPath ? 'path' : 'branch'}.</div>
              ) : (
                commits.map(c => (
                  <div key={c.sha} className="p-4 hover:bg-surface-subtle/50 transition flex items-center justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <Avatar
                        name={c.author.display_name || c.author.identity.name}
                        url={c.author.avatar_url}
                        size={32}
                        className="border-border-subtle"
                      />
                      <div className="space-y-1 min-w-0">
                        <p className="text-sm font-semibold text-txt-primary">{c.title || c.message}</p>
                        <div className="flex items-center gap-3 text-xs text-txt-tertiary font-mono flex-wrap">
                          <span className="font-sans text-txt-secondary">{authorLink(c)}</span>
                          <span>{new Date(c.author.when).toLocaleDateString()}</span>
                          {c.committer.linked && c.committer.uid && c.author.uid !== c.committer.uid && (
                            <span className="font-sans">committed by&nbsp;
                              <Link to={`/${c.committer.uid}`} className="text-txt-brand hover:underline">{c.committer.display_name}</Link>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => goToCommit(c.sha)}
                      className="p-1.5 rounded bg-surface-base border border-border-subtle font-mono text-xs text-txt-brand hover:bg-surface-subtle transition shrink-0"
                    >
                      {c.sha.slice(0, 7)}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )
      )}

      {/* TAB CONTENT: PULL REQUESTS */}
      {activeTab === 'pulls' && (
        <>
          {selectedPrNumber === 'new' ? (
            <PullRequestForm
              repoPath={repoPath}
              branches={branches}
              defaultBranch={repo.default_branch}
              onCreated={created => setSearchParams({ tab: 'pulls', pr: String(created.number) })}
              onCancel={() => setSearchParams({ tab: 'pulls' })}
            />
          ) : typeof selectedPrNumber === 'number' ? (
            <PullRequestDetail
              repoPath={repoPath}
              prNumber={selectedPrNumber}
              onBack={() => setSearchParams({ tab: 'pulls' })}
            />
          ) : (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider">Pull Requests</h3>
                <button
                  onClick={() => setSearchParams({ tab: 'pulls', pr: 'new' })}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover transition shadow-sm flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Pull Request</span>
                </button>
              </div>
              <div className="border border-border-subtle rounded-lg bg-surface-canvas divide-y divide-border-subtle overflow-hidden">
                {pullRequests.length === 0 ? (
                  <div className="p-12 text-center text-xs text-txt-tertiary font-mono">
                    No pull requests found.
                  </div>
                ) : (
                  pullRequests.map(pr => (
                    <button
                      key={pr.number}
                      onClick={() => setSearchParams({ tab: 'pulls', pr: String(pr.number) })}
                      className="w-full p-4 hover:bg-surface-subtle/50 transition flex items-center justify-between gap-4 text-left"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <GitPullRequest className="w-4 h-4 text-txt-open" />
                          <span className="text-sm font-semibold text-txt-primary font-mono">#{pr.number}</span>
                          <span className="text-sm font-medium text-txt-primary">{pr.title}</span>
                        </div>
                        <div className="text-xs text-txt-tertiary font-mono">
                          <span>by {pr.author?.display_name || pr.author?.uid}</span>
                          <span className="mx-2">•</span>
                          <span>{pr.source_branch} → {pr.target_branch}</span>
                        </div>
                      </div>
                      <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-semibold ${
                        pr.state === 'open' ? 'bg-surface-open text-txt-open' : 'bg-surface-merged text-txt-merged'
                      }`}>
                        {pr.state}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* TAB CONTENT: BRANCHES */}
      {activeTab === 'branches' && (
        <div className="border border-border-subtle rounded-lg bg-surface-canvas divide-y divide-border-subtle overflow-hidden">
          {branches.map(b => (
            <div key={b.name} className="p-4 hover:bg-surface-subtle/50 transition flex items-center justify-between gap-4 font-mono text-xs">
              <div className="flex items-center gap-2 font-medium text-txt-primary">
                <GitBranch className="w-4 h-4 text-brand" />
                <span>{b.name}</span>
                {b.name === repo.default_branch && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-subtle text-txt-tertiary border border-border-subtle">
                    default
                  </span>
                )}
              </div>
              <span className="text-txt-tertiary">{b.sha.slice(0, 7)}</span>
            </div>
          ))}
        </div>
      )}

      {/* TAB CONTENT: SETTINGS */}
      {activeTab === 'settings' && space && (
        <RepoSettingsPanel
          repo={repo}
          repoPath={repoPath}
          space={space}
          onUpdated={setRepo}
        />
      )}
      </div>
      </div>
    </div>
  );
};

// Single-commit detail view: author, stats, and the files it touched.
const CommitDetailView: React.FC<{
  detail: CommitDetail;
  onBack: () => void;
}> = ({ detail, onBack }) => {
  const c = detail.commit;
  return (
    <div className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden">
      <div className="p-4 border-b border-border-subtle space-y-3">
        <button onClick={onBack} className="inline-flex items-center gap-1 text-xs text-txt-secondary hover:text-txt-primary transition">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>All commits</span>
        </button>
        <div className="flex items-start gap-3 min-w-0">
          <Avatar
            name={c.author.display_name || c.author.identity.name}
            url={c.author.avatar_url}
            size={36}
            className="border-border-subtle"
          />
          <div className="space-y-1 min-w-0">
            <h3 className="text-sm font-semibold text-txt-primary">{c.title}</h3>
            <p className="text-[11px] font-mono text-txt-brand">{c.sha}</p>
            <p className="text-xs text-txt-tertiary font-mono">
              {c.author.display_name || c.author.identity.name} · {new Date(c.author.when).toLocaleString()}
            </p>
          </div>
          <div className="ml-auto text-xs font-mono text-txt-secondary shrink-0">
            <span className="text-txt-open">+{detail.stats.additions}</span>
            <span className="mx-1 text-txt-tertiary">/</span>
            <span className="text-txt-merged">-{detail.stats.deletions}</span>
          </div>
        </div>
      </div>
      {detail.files.length === 0 ? (
        <div className="p-8 text-center text-xs text-txt-tertiary font-mono">No file changes in this commit.</div>
      ) : (
        <div className="divide-y divide-border-subtle">
          {detail.files.map(f => (
            <div key={f.path} className="flex items-center justify-between px-4 py-2 text-xs font-mono gap-3">
              <span className="text-txt-primary truncate min-w-0">{f.path}</span>
              <span className="text-txt-tertiary shrink-0">
                <span className="text-txt-open">+{f.additions}</span>
                <span className="mx-1">·</span>
                <span className="text-txt-merged">-{f.deletions}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
