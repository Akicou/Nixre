import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RepoView } from '../pages/RepoView';
import { repo, treeEntries, branch, commit, pullRequest } from './fixtures';

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
  },
}));

vi.mock('../lib/api', () => ({ api }));

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
});

function mountAt(initialPath: string) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/:space/:repo" element={<RepoView />} />
      </Routes>
    </MemoryRouter>
  );
  return render(<RepoView />, { wrapper });
}

describe('RepoView — Code tree', () => {
  it('renders the repository file tree from the top-level entries (Gitness content API)', async () => {
    mountAt('/acme/website?tab=code&branch=main&type=tree');
    // README.md shows both in the table row and the inline README box; the
    // folder and other files render normally in the tree.
    await screen.findByText('LICENSE');
    await screen.findByText('ui');
    // Exactly one file-tree row per entry (3 entries, no ".." at root).
    const table = (await screen.findByRole('table')) as HTMLTableElement;
    expect(table.rows.length).toBe(4); // header + 3 entries
  });

  it('does not render an empty tree when the backend returns entries', async () => {
    api.getTree.mockResolvedValue({ entries: [] });
    mountAt('/acme/website?tab=code&branch=main&type=tree');
    // No rows beyond the table header.
    await waitFor(() => {
      expect(screen.queryByText('README.md')).toBeNull();
    });
  });

  it('navigates into a folder and shows a breadcrumb ".." with a parent link', async () => {
    mountAt('/acme/website?tab=code&branch=main&type=tree');
    await screen.findByText('ui');
    fireEvent.click((await screen.findByText('ui')).closest('tr')!);
    await screen.findByText('app.tsx');
    // Inside a subdirectory, the ".." parent row appears.
    expect(await screen.findByText('..')).toBeInTheDocument();
  });

  it('opens a file as a blob view when clicked', async () => {
    mountAt('/acme/website?tab=code&branch=main&type=tree');
    const readmeCell = await screen.findAllByText('README.md');
    const readmeRow = readmeCell[0].closest('tr');
    expect(readmeRow).toBeDefined();
    fireEvent.click(readmeRow!);
    // The blob view renders the file header with its byte size.
    expect(await screen.findByText(/22 bytes/)).toBeInTheDocument();
    // And the raw file content is shown.
    expect(screen.getByText(/Hello world/)).toBeInTheDocument();
  });

  it('renders the README inline on the code view', async () => {
    mountAt('/acme/website?tab=code&branch=main&type=tree');
    // The README entry triggers a raw fetch; the README box appears.
    expect(await screen.findByText('README.md')).toBeInTheDocument();
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
