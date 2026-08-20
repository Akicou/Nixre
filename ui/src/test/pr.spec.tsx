import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PullRequestForm } from '../components/PullRequestForm';
import { PullRequestDetail } from '../components/PullRequestDetail';
import { branch, pullRequest } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: {
    createPullRequest: vi.fn(),
    getPullRequest: vi.fn(),
    getPullRequestDiff: vi.fn(),
    mergePullRequest: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({ api }));

const branches = [branch, { name: 'feature', sha: '6666666666666666666666666666666666666666' }];

describe('PullRequestForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mount(onCreated = vi.fn(), onCancel = vi.fn()) {
    return render(
      <PullRequestForm
        repoPath="acme/website"
        branches={branches}
        defaultBranch="main"
        onCreated={onCreated}
        onCancel={onCancel}
      />,
    );
  }

  it('rejects a PR with identical source and target branches', async () => {
    mount();
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'main' } });
    fireEvent.change(selects[1], { target: { value: 'main' } });
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: 'Title' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Pull Request/ }));

    expect(await screen.findByText(/Source and target branch must be different/)).toBeInTheDocument();
    expect(api.createPullRequest).not.toHaveBeenCalled();
  });

  it('creates a pull request and notifies the parent', async () => {
    const onCreated = vi.fn();
    api.createPullRequest.mockResolvedValue(pullRequest);
    mount(onCreated);

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'feature' } });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'main' } });
    fireEvent.change(screen.getByPlaceholderText(/Short summary/), { target: { value: 'Add landing page' } });
    fireEvent.change(screen.getByPlaceholderText(/What does this change do/), { target: { value: 'Description' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Pull Request/ }));

    await waitFor(() => {
      expect(api.createPullRequest).toHaveBeenCalledWith(
        'acme/website',
        'Add landing page',
        'Description',
        'feature',
        'main',
      );
      expect(onCreated).toHaveBeenCalledWith(pullRequest);
    });
  });
});

describe('PullRequestDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mount(onBack = vi.fn()) {
    return render(
      <PullRequestDetail repoPath="acme/website" prNumber={7} onBack={onBack} />,
    );
  }

  it('renders the PR and its file diff', async () => {
    api.getPullRequest.mockResolvedValue(pullRequest);
    const patch = btoa('@@ -1,1 +1,1 @@\n-old line\n+new line\n');
    api.getPullRequestDiff.mockResolvedValue([
      { sha: 'x', path: 'index.html', status: 'MODIFIED', additions: 1, deletions: 1, changes: 2, patch, is_binary: false, is_submodule: false },
    ]);

    mount();

    expect(await screen.findByText(/Add landing page/)).toBeInTheDocument();
    expect(await screen.findByText(/index\.html/)).toBeInTheDocument();
    expect(await screen.findByText(/\+new line/)).toBeInTheDocument();
  });

  it('merges an open PR and refreshes its state', async () => {
    api.getPullRequest.mockResolvedValue(pullRequest);
    api.getPullRequestDiff.mockResolvedValue([]);
    api.mergePullRequest.mockResolvedValue(undefined);
    const merged = { ...pullRequest, state: 'merged' as const };
    api.getPullRequest
      .mockResolvedValueOnce(pullRequest)
      .mockResolvedValueOnce(merged);

    mount();
    const mergeBtn = await screen.findByRole('button', { name: /Merge Pull Request/ });
    fireEvent.click(mergeBtn);

    await waitFor(() => {
      expect(api.mergePullRequest).toHaveBeenCalledWith('acme/website', 7, 'merge');
    });
    expect(await screen.findByText('merged')).toBeInTheDocument();
  });
});
