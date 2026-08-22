import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import {
  GitBranch,
  GitCommit,
  GitPullRequest,
  File,
  Folder,
  Copy,
  Check,
  ChevronDown,
  Download,
  Plus,
  ArrowLeft,
  FileCode,
  Settings
} from 'lucide-react';
import { api, Repository, TreeEntry, Commit, Branch, PullRequest } from '../lib/api';
import { resolveNodeType } from '../lib/repoPath';
import { useOutsideClick } from '../lib/useOutsideClick';
import { PullRequestForm } from '../components/PullRequestForm';
import { PullRequestDetail } from '../components/PullRequestDetail';
import { RepoSettingsPanel } from '../components/RepoSettingsPanel';
import { Markdown, isMarkdownFile } from '../components/Markdown';

export const RepoView: React.FC = () => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const repoPath = `${space}/${repoUid}`;

  const activeTab = searchParams.get('tab') || 'code';
  const currentBranch = searchParams.get('branch') || 'main';
  const currentPath = searchParams.get('path') || '';
  const currentNodeType = resolveNodeType(searchParams.get('type'));
  const prParam = searchParams.get('pr');
  const selectedPrNumber: number | 'new' | null = prParam === 'new' ? 'new' : prParam ? Number(prParam) : null;

  const [repo, setRepo] = useState<Repository | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [treeEntries, setTreeEntries] = useState<TreeEntry[]>([]);
  const [fileBlob, setFileBlob] = useState<{ content: string; name: string; size: number } | null>(null);
  const [readmeContent, setReadmeContent] = useState<string | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [pullRequests, setPullRequests] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [cloneDropdownOpen, setCloneDropdownOpen] = useState(false);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cloneProtocol, setCloneProtocol] = useState<'http' | 'ssh'>('http');
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
      api.getCommits(repoPath, currentBranch)
        .then(res => setCommits(res.commits))
        .catch(() => setCommits([]));
    } else if (activeTab === 'pulls') {
      api.listPullRequests(repoPath)
        .then(prs => setPullRequests(prs))
        .catch(() => setPullRequests([]));
    }
  }, [repo, activeTab, currentBranch, currentPath, currentNodeType]);

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
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* Repo Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border-subtle pb-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-base font-mono">
            <Link to={`/${space}`} className="text-txt-brand hover:underline font-medium">
              {space}
            </Link>
            <span className="text-txt-tertiary">/</span>
            <span className="font-semibold text-txt-primary">{repo.uid}</span>
            <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary ml-2">
              {repo.is_public ? 'Public' : 'Private'}
            </span>
          </div>
          {repo.description && (
            <p className="text-xs text-txt-secondary">{repo.description}</p>
          )}
        </div>

        {/* Clone Button & Dropdown */}
        <div className="relative" ref={cloneMenuRef}>
          <button
            onClick={() => setCloneDropdownOpen(!cloneDropdownOpen)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-brand text-white hover:bg-brand-hover text-xs font-medium transition shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Clone Repo</span>
            <ChevronDown className="w-3.5 h-3.5 opacity-80" />
          </button>

          {cloneDropdownOpen && (
            <div className="absolute right-0 mt-2 w-80 rounded-md bg-surface-canvas border border-border-mid shadow-xl p-3 z-50 animate-pop">
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
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border-subtle overflow-x-auto flex-nowrap scrollbar-thin">
        <button
          onClick={() => { setSearchParams({ tab: 'code', branch: currentBranch, type: 'tree' }); }}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px shrink-0 whitespace-nowrap ${
            activeTab === 'code' ? 'border-brand text-txt-primary font-semibold' : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          <FileCode className="w-4 h-4" />
          <span>Code</span>
        </button>

        <button
          onClick={() => { setSearchParams({ tab: 'commits', branch: currentBranch }); }}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px shrink-0 whitespace-nowrap ${
            activeTab === 'commits' ? 'border-brand text-txt-primary font-semibold' : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          <GitCommit className="w-4 h-4" />
          <span>Commits</span>
        </button>

        <button
          onClick={() => { setSearchParams({ tab: 'pulls' }); }}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px shrink-0 whitespace-nowrap ${
            activeTab === 'pulls' ? 'border-brand text-txt-primary font-semibold' : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          <GitPullRequest className="w-4 h-4" />
          <span>Pull Requests</span>
          {repo.num_open_pulls > 0 && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-surface-open text-txt-open">
              {repo.num_open_pulls}
            </span>
          )}
        </button>

        <button
          onClick={() => { setSearchParams({ tab: 'branches' }); }}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px shrink-0 whitespace-nowrap ${
            activeTab === 'branches' ? 'border-brand text-txt-primary font-semibold' : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          <GitBranch className="w-4 h-4" />
          <span>Branches ({branches.length})</span>
        </button>

        <button
          onClick={() => { setSearchParams({ tab: 'settings' }); }}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px shrink-0 whitespace-nowrap ${
            activeTab === 'settings' ? 'border-brand text-txt-primary font-semibold' : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          <Settings className="w-4 h-4" />
          <span>Settings</span>
        </button>
      </div>

      {/* TAB CONTENT: CODE */}
      {activeTab === 'code' && (
        <div className="space-y-6">
          {/* Branch & Path Bar */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 flex-wrap">
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
              <div className="flex items-center gap-1.5 text-xs font-mono text-txt-secondary">
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
          </div>

          {/* If Single File Blob is active */}
          {fileBlob ? (
            <div className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden">
              <div className="p-3 bg-surface-base border-b border-border-subtle flex items-center justify-between text-xs font-mono">
                <div className="flex items-center gap-2 text-txt-primary font-semibold">
                  <File className="w-4 h-4 text-brand" />
                  <span>{fileBlob.name}</span>
                  <span className="text-txt-tertiary font-normal">({fileBlob.size} bytes)</span>
                </div>
                <button
                  onClick={() => copyToClipboard(fileBlob.content)}
                  className="p-1 rounded hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
                  title="Copy raw file"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-txt-open" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
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
                  {treeEntries.map(entry => (
                    <tr
                      key={entry.name}
                      onClick={() => {
                        const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
                        setSearchParams({ tab: 'code', branch: currentBranch, path: nextPath, type: entry.type });
                      }}
                      className="hover:bg-surface-subtle/50 cursor-pointer transition"
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
                      </td>
                      <td className="py-2.5 px-4 text-right text-txt-tertiary font-mono">
                        {entry.sha.slice(0, 7)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* README Rendered Box */}
          {readmeContent && !fileBlob && (
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
        <div className="border border-border-subtle rounded-lg bg-surface-canvas divide-y divide-border-subtle overflow-hidden">
          {commits.length === 0 ? (
            <div className="p-8 text-center text-xs text-txt-tertiary font-mono">No commits found for this branch.</div>
          ) : (
            commits.map(c => (
              <div key={c.sha} className="p-4 hover:bg-surface-subtle/50 transition flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-txt-primary">{c.title || c.message}</p>
                  <div className="flex items-center gap-3 text-xs text-txt-tertiary font-mono">
                    <span className="font-sans font-medium text-txt-secondary">{c.author.identity.name}</span>
                    <span>{new Date(c.author.when).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="p-1.5 rounded bg-surface-base border border-border-subtle font-mono text-xs text-txt-brand">
                  {c.sha.slice(0, 7)}
                </div>
              </div>
            ))
          )}
        </div>
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
  );
};
