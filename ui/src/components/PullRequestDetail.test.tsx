import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PullRequestDetail } from './PullRequestDetail';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    getPullRequest: vi.fn(),
    getPullRequestDiff: vi.fn(),
    mergePullRequest: vi.fn(),
  },
}));

const basePr = {
  number: 5,
  title: 'Add feature',
  description: 'Does a thing',
  state: 'open' as const,
  is_draft: false,
  source_branch: 'feature',
  target_branch: 'main',
  author: { uid: 'me', display_name: 'Me', email: 'me@nixre.dev' },
  created: 0,
  updated: 0,
};

describe('PullRequestDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders decoded diff content from the base64 patch field', async () => {
    (api.getPullRequest as any).mockResolvedValue(basePr);
    (api.getPullRequestDiff as any).mockResolvedValue([
      {
        sha: 'a', path: 'a.txt', status: 'MODIFIED', additions: 1, deletions: 1, changes: 2,
        patch: btoa('@@ -1 +1 @@\n-old line\n+new line\n'),
        is_binary: false, is_submodule: false,
      },
    ]);

    render(<PullRequestDetail repoPath="space/repo" prNumber={5} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('+new line')).toBeInTheDocument();
      expect(screen.getByText('-old line')).toBeInTheDocument();
    });
  });

  it('calls api.mergePullRequest when the merge button is clicked', async () => {
    (api.getPullRequest as any).mockResolvedValue(basePr);
    (api.getPullRequestDiff as any).mockResolvedValue([]);
    (api.mergePullRequest as any).mockResolvedValue(undefined);

    render(<PullRequestDetail repoPath="space/repo" prNumber={5} onBack={vi.fn()} />);

    const mergeButton = await screen.findByText('Merge Pull Request');
    fireEvent.click(mergeButton);

    await waitFor(() => {
      expect(api.mergePullRequest).toHaveBeenCalledWith('space/repo', 5, 'merge');
    });
  });

  it('does not show the merge button for an already-merged PR', async () => {
    (api.getPullRequest as any).mockResolvedValue({ ...basePr, state: 'merged' });
    (api.getPullRequestDiff as any).mockResolvedValue([]);

    render(<PullRequestDetail repoPath="space/repo" prNumber={5} onBack={vi.fn()} />);

    await screen.findByText('Add feature');
    expect(screen.queryByText('Merge Pull Request')).not.toBeInTheDocument();
  });
});
