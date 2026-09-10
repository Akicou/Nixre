import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RepoView } from '../pages/RepoView';
import { repo, treeEntries, branch, commit, pullRequest, user } from './fixtures';
import { getAllPrefs, putPref } from '../lib/syncApi';

const { api } = vi.hoisted(() => ({
  api: {
    getRepo: vi.fn(),
    getBranches: vi.fn(),
    getTree: vi.fn(),
    getRawBlob: vi.fn(),
    getCommits: vi.fn(),
    listPullRequests: vi.fn(),
    getPullRequest: vi.fn(),
    getPullRequestDiff: vi.fn(),
    createPullRequest: vi.fn(),
    mergePullRequest: vi.fn(),
    commitFiles: vi.fn(),
    listDeployServices: vi.fn(),
    serviceUptime: vi.fn(),
    serviceStats: vi.fn(),
    detectDockerfiles: vi.fn(),
    listEnvVars: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({ api }));
vi.mock('../lib/syncApi', () => ({ getAllPrefs: vi.fn(), putPref: vi.fn() }));
vi.mock('../lib/deployEvents', () => ({ subscribeDeployEvents: () => () => {} }));
const service = { id: 12, name: 'web', branch: 'main', root_dir: '.', dockerfile_path: 'Dockerfile', container_port: 3000,
  status: 'running', desired_state: 'running', cpu_nano_cpus: 1e9, memory_bytes: 536870912, auto_deploy: true };

beforeEach(() => {
  vi.clearAllMocks();
  api.getRepo.mockResolvedValue(repo);
  api.getBranches.mockResolvedValue([branch]);
  api.getTree.mockImplementation(async (_repoRef, _branch, path: string) => {
    if (path === 'ui') {
      return {
        entries: [
          { path: 'ui/src/app.tsx', name: 'app.tsx', type: 'blob', mode: 33188, sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', size: 10 },
        ],
      };
    }
    return { entries: treeEntries };
  });
  api.getRawBlob.mockResolvedValue({ content: '# README\nHello world', name: 'README.md', size: 22 });
  api.getCommits.mockResolvedValue({ commits: [commit] });
  api.listPullRequests.mockResolvedValue([pullRequest]);
  api.listDeployServices.mockResolvedValue([service]);
  api.serviceUptime.mockResolvedValue({ buckets: [] });
  api.serviceStats.mockResolvedValue({ limits: { memory_bytes: 536870912 }, latest: null, series: [] });
  vi.mocked(getAllPrefs).mockResolvedValue({});
  vi.mocked(putPref).mockResolvedValue(undefined);
});

function mountAt(initialPath: string, signedIn = true) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/:space/:repo" element={<RepoView user={signedIn ? user : null} />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('RepoView — Code tree', () => {
  it('renders the repository file tree from the top-level entries (Gitness content API)', async () => {
    mountAt('/acme/website?tab=code&branch=main&type=tree');
    // README.md shows both in the table row and the inline README box; the
    // folder and other files render normally in the tree.
    await screen.findByText('LICENSE');
    await screen.findByText('ui');
    expect(within(await screen.findByRole('tree')).getAllByRole('treeitem')).toHaveLength(3);
    expect(await screen.findByRole('button', { name: 'View service web' })).toBeInTheDocument();
    expect(api.getTree).toHaveBeenCalledTimes(1);
  });

  it('does not render an empty tree when the backend returns entries', async () => {
    api.getTree.mockResolvedValue({ entries: [] });
    mountAt('/acme/website?tab=code&branch=main&type=tree');
    expect(await screen.findByText('This repository is empty.')).toBeInTheDocument();
    expect(screen.queryByRole('treeitem')).toBeNull();
  });

  it('expands folders in place and can collapse them', async () => {
    mountAt('/acme/website?tab=code&branch=main&type=tree');
    const folder = await screen.findByRole('treeitem', { name: 'ui' });
    fireEvent.click(folder);
    expect(await screen.findByRole('treeitem', { name: 'app.tsx' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'LICENSE' })).toBeInTheDocument();
    expect(folder).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(folder);
    expect(screen.queryByRole('treeitem', { name: 'app.tsx' })).toBeNull();
  });

  it('opens a file as a blob view when clicked', async () => {
    mountAt('/acme/website?tab=code&branch=main&type=tree');
    fireEvent.click(await screen.findByRole('treeitem', { name: 'README.md' }));
    // The blob view renders the file header with its byte size.
    expect(await screen.findByText(/22 bytes/)).toBeInTheDocument();
    // And the raw file content is shown.
    expect(screen.getByText(/Hello world/)).toBeInTheDocument();
  });

  it('renders the README inline on the code view', async () => {
    mountAt('/acme/website?tab=code&branch=main&type=tree');
    // The README entry triggers a raw fetch; the README box appears.
    expect(await within(await screen.findByRole('region', { name: 'File preview' })).findByText(/Hello world/)).toBeInTheDocument();
  });
});

describe('RepoView — workspace layouts', () => {
  it('shows files and deployments by default without query parameters', async () => {
    mountAt('/acme/website');
    expect(await screen.findByRole('tree', { name: 'Repository files' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'View service web' })).toBeInTheDocument();
    expect(screen.getByTestId('repository-workspace')).toHaveAttribute('data-layout', 'split');
    expect(screen.queryByTestId('deployments-sidebar-toggle')).toBeNull();
    expect(api.listDeployServices).toHaveBeenCalledTimes(1);
  });

  it('restores the saved preference and changes it without resetting expanded folders', async () => {
    vi.mocked(getAllPrefs).mockResolvedValue({ repository_layout: 'columns' });
    mountAt('/acme/website');
    await waitFor(() => expect(screen.getByTestId('repository-workspace')).toHaveAttribute('data-layout', 'columns'));
    fireEvent.click(await screen.findByRole('treeitem', { name: 'ui' }));
    await screen.findByRole('treeitem', { name: 'app.tsx' });
    fireEvent.change(screen.getByLabelText('Repository layout'), { target: { value: 'split' } });
    await waitFor(() => expect(putPref).toHaveBeenCalledWith('repository_layout', 'split'));
    expect(screen.getByRole('treeitem', { name: 'ui' })).toHaveAttribute('aria-expanded', 'true');
    expect(api.listDeployServices).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a selection with a late preference read', async () => {
    let finish!: (value: Record<string, unknown>) => void;
    vi.mocked(getAllPrefs).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mountAt('/acme/website');
    fireEvent.change(await screen.findByLabelText('Repository layout'), { target: { value: 'columns' } });
    await act(async () => finish({ repository_layout: 'split' }));
    expect(screen.getByTestId('repository-workspace')).toHaveAttribute('data-layout', 'columns');
  });
  it('persists the selected layout across visits', async () => {
    let saved: unknown = 'split';
    vi.mocked(getAllPrefs).mockImplementation(async () => ({ repository_layout: saved }));
    vi.mocked(putPref).mockImplementation(async (_key, value) => { saved = value; });
    const first = mountAt('/acme/website');
    fireEvent.change(await screen.findByLabelText('Repository layout'), { target: { value: 'columns' } });
    await waitFor(() => expect(saved).toBe('columns'));
    first.unmount();
    mountAt('/acme/website');
    await waitFor(() => expect(screen.getByLabelText('Repository layout')).toHaveValue('columns'));
  });

  it('falls back for unknown preferences and reports save failures', async () => {
    vi.mocked(getAllPrefs).mockResolvedValue({ repository_layout: 'unknown-layout' });
    vi.mocked(putPref).mockRejectedValue(new Error('offline'));
    mountAt('/acme/website');
    expect(await screen.findByLabelText('Repository layout')).toHaveValue('split');
    fireEvent.change(screen.getByLabelText('Repository layout'), { target: { value: 'columns' } });
    expect(await screen.findByText(/Layout changed here, but could not be saved/)).toBeInTheDocument();
    expect(screen.getByLabelText('Repository layout')).toHaveValue('columns');
  });

  it('keeps a file editor draft through layout changes', async () => {
    api.getRepo.mockResolvedValue({ ...repo, can_write: true });
    mountAt('/acme/website?path=README.md&type=blob');
    fireEvent.click(await screen.findByTitle('Edit this file'));
    fireEvent.change(await screen.findByLabelText('File contents'), { target: { value: 'Unsaved text' } });
    fireEvent.change(screen.getByLabelText('Repository layout'), { target: { value: 'columns' } });
    expect(screen.getByLabelText('File contents')).toHaveValue('Unsaved text');
  });

  it('opens service links alongside the tree and preserves the service during file navigation', async () => {
    mountAt('/acme/website?tab=deployments&svc=12&dtab=overview');
    expect(await screen.findByText('All services')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('treeitem', { name: 'README.md' }));
    expect(await screen.findByText(/22 bytes/)).toBeInTheDocument();
    expect(screen.getByText('All services')).toBeInTheDocument();
    expect(api.listDeployServices).toHaveBeenCalledTimes(1);
  });

  it('shows a login state for guests without making authenticated deployment requests', async () => {
    mountAt('/acme/website', false);
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
    expect(api.listDeployServices).not.toHaveBeenCalled();
    expect(getAllPrefs).not.toHaveBeenCalled();
  });

  it('reports deployment failures with retry rather than an empty creation state', async () => {
    api.listDeployServices.mockRejectedValueOnce(new Error('Unavailable'));
    mountAt('/acme/website');
    expect(await screen.findByText('Deployments unavailable: Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No deployment services on this repository yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry deployments' }));
    expect(await screen.findByRole('button', { name: 'View service web' })).toBeInTheDocument();
  });

  it('uses the repository default branch and expands ancestors of a linked file', async () => {
    api.getRepo.mockResolvedValue({ ...repo, default_branch: 'trunk' });
    mountAt('/acme/website?path=ui/app.tsx&type=blob');
    expect(await screen.findByRole('treeitem', { name: 'app.tsx' })).toHaveAttribute('aria-selected', 'true');
    expect(api.getTree).toHaveBeenCalledWith('acme/website', 'trunk', 'ui');
    expect(screen.getByRole('treeitem', { name: 'ui' })).toHaveAttribute('aria-expanded', 'true');
  });
  it('supports keyboard folder navigation and retrying a failed folder load', async () => {
    api.getTree.mockImplementation(async (_repoRef, _branch, path: string) => {
      if (path === 'ui') throw new Error('Folder unavailable');
      return { entries: treeEntries };
    });
    mountAt('/acme/website');
    const folder = await screen.findByRole('treeitem', { name: 'ui' });
    fireEvent.keyDown(folder, { key: 'ArrowRight' });
    expect(await screen.findByText('Folder unavailable')).toBeInTheDocument();
    api.getTree.mockImplementation(async (_repoRef, _branch, path: string) => ({ entries: path === 'ui' ? [{ name: 'app.tsx', type: 'blob' }] : treeEntries }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry ui' }));
    const file = await screen.findByRole('treeitem', { name: 'app.tsx' });
    fireEvent.keyDown(folder, { key: 'ArrowRight' });
    expect(file).toHaveFocus();
    fireEvent.keyDown(file, { key: 'ArrowLeft' });
    expect(folder).toHaveFocus();
  });

  it('keeps deployment details mounted while changing layout', async () => {
    api.getRepo.mockResolvedValue({ ...repo, can_write: true });
    mountAt('/acme/website');
    fireEvent.click(await screen.findByRole('button', { name: 'View service web' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByDisplayValue('web'), { target: { value: 'draft-name' } });
    fireEvent.change(screen.getByLabelText('Repository layout'), { target: { value: 'columns' } });
    expect(screen.getByDisplayValue('draft-name')).toBeInTheDocument();
    expect(api.listDeployServices).toHaveBeenCalledTimes(1);
  });

  it('provides a read-only deployment view without mutation controls', async () => {
    mountAt('/acme/website');
    expect(await screen.findByRole('button', { name: 'View service web' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New service' })).toBeNull();
    expect(screen.queryByTitle('Stop serving')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View service web' }));
    expect(await screen.findByText('CPU (of limit)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deploy latest' })).toBeNull();
  });
});

describe('RepoView — tabs', () => {
  it('shows commits in the Commits tab', async () => {
    mountAt('/acme/website?tab=commits&branch=main');
    expect(await screen.findByText('Initial commit')).toBeInTheDocument();
    expect(await screen.findByText('5555555')).toBeInTheDocument();
  });

  it('lists branches in the Branches tab', async () => {
    mountAt('/acme/website?tab=branches&branch=main');
    expect(await screen.findByText('main')).toBeInTheDocument();
  });

  it('lists pull requests in the Pulls tab', async () => {
    mountAt('/acme/website?tab=pulls');
    expect(await screen.findByText('#7')).toBeInTheDocument();
    expect(await screen.findByText('Add landing page')).toBeInTheDocument();
  });
});

describe('RepoView — web edit', () => {
  it('hides Add file when the user cannot write', async () => {
    mountAt('/acme/website?tab=code&branch=main&type=tree');
    await screen.findByText('LICENSE');
    expect(screen.queryByRole('button', { name: 'Add file' })).toBeNull();
  });

  it('opens the editor with the file text and can preview markdown', async () => {
    api.getRepo.mockResolvedValue({ ...repo, can_write: true });
    mountAt('/acme/website?tab=code&branch=main&path=README.md&type=blob');

    fireEvent.click(await screen.findByTitle('Edit this file'));
    const editor = await screen.findByLabelText('File contents');
    expect(editor).toHaveValue('# README\nHello world');

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.queryByLabelText('File contents')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByLabelText('File contents')).toHaveValue('# README\nHello world');
  });

  it('edits a file and commits to a new branch', async () => {
    api.getRepo.mockResolvedValue({ ...repo, can_write: true });
    api.commitFiles.mockResolvedValue({ sha: 'newsha', branch: 'edit-readme' });
    mountAt('/acme/website?tab=code&branch=main&path=README.md&type=blob');

    fireEvent.click(await screen.findByTitle('Edit this file'));
    const editor = await screen.findByLabelText('File contents');
    fireEvent.change(editor, { target: { value: '# Hello edit' } });
    fireEvent.click(screen.getByRole('radio', { name: /Commit to a new branch/i }));
    fireEvent.change(screen.getByLabelText('New branch name'), { target: { value: 'edit-readme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }));

    await waitFor(() => {
      expect(api.commitFiles).toHaveBeenCalledWith('acme/website', expect.objectContaining({
        branch: 'main',
        new_branch: 'edit-readme',
        files: [{ path: 'README.md', content: '# Hello edit', action: 'update' }],
      }));
    });
  });
});
