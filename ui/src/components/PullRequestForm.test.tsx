import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PullRequestForm } from './PullRequestForm';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    createPullRequest: vi.fn(),
  },
}));

const branches = [
  { name: 'main', sha: 'abc' },
  { name: 'feature', sha: 'def' },
];

describe('PullRequestForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects submitting when source and target branch are the same', async () => {
    const onCreated = vi.fn();
    render(
      <PullRequestForm
        repoPath="space/repo"
        branches={branches}
        defaultBranch="main"
        onCreated={onCreated}
        onCancel={vi.fn()}
      />
    );

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'main' } });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'main' } });
    fireEvent.change(screen.getByPlaceholderText('Short summary of the change'), { target: { value: 'title' } });
    fireEvent.click(screen.getByText('Create Pull Request'));

    expect(await screen.findByText(/must be different/i)).toBeInTheDocument();
    expect(api.createPullRequest).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('calls api.createPullRequest and onCreated with valid distinct branches', async () => {
    const createdPr = { number: 9, title: 'title', description: '', state: 'open', is_draft: false, source_branch: 'feature', target_branch: 'main', author: { uid: 'me', display_name: 'Me', email: '' }, created: 0, updated: 0 };
    (api.createPullRequest as any).mockResolvedValue(createdPr);
    const onCreated = vi.fn();

    render(
      <PullRequestForm
        repoPath="space/repo"
        branches={branches}
        defaultBranch="main"
        onCreated={onCreated}
        onCancel={vi.fn()}
      />
    );

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'feature' } });
    fireEvent.change(screen.getByPlaceholderText('Short summary of the change'), { target: { value: 'title' } });
    fireEvent.click(screen.getByText('Create Pull Request'));

    await waitFor(() => {
      expect(api.createPullRequest).toHaveBeenCalledWith('space/repo', 'title', '', 'feature', 'main');
      expect(onCreated).toHaveBeenCalledWith(createdPr);
    });
  });
});
