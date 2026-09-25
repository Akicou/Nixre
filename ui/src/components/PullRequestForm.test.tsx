import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PullRequestForm } from './PullRequestForm';
import { api } from '../lib/api';
import { streamAiChat } from '../lib/aiApi';

vi.mock('../lib/api', () => ({
  api: {
    createPullRequest: vi.fn(),
    compareBranches: vi.fn(),
    compareCommits: vi.fn(),
  },
}));

vi.mock('../lib/assistantProfiles', () => ({
  getActiveProviderProfile: vi.fn(async () => ({
    provider: 'openai', model: 'gpt-test', keyConfigured: true, validatedAt: 1,
  })),
  isRealAi: () => true,
}));

vi.mock('../lib/aiApi', () => ({ streamAiChat: vi.fn() }));

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

  describe('assistant-drafted description', () => {
    const renderForm = () =>
      render(
        <PullRequestForm
          repoPath="space/repo"
          branches={branches}
          defaultBranch="main"
          onCreated={vi.fn()}
          onCancel={vi.fn()}
        />
      );

    const pickSourceAndDraft = async () => {
      const btn = await screen.findByText('Generate with assistant');
      fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'feature' } });
      fireEvent.click(btn);
    };

    it('asks for the changes not yet in the TARGET, not the target own changes', async () => {
      (api.compareBranches as any).mockResolvedValue([
        { path: 'c4.txt', status: 'MODIFIED', additions: 1, deletions: 0 },
      ]);
      (api.compareCommits as any).mockResolvedValue([{ sha: 'aaa', title: 'commit 4' }]);
      renderForm();
      await pickSourceAndDraft();

      // base = target, head = source. Swapped arguments described the target.
      await waitFor(() => {
        expect(api.compareBranches).toHaveBeenCalledWith('space/repo', 'main', 'feature');
        expect(api.compareCommits).toHaveBeenCalledWith('space/repo', 'main', 'feature');
      });
    });

    it('sends the unmerged commits and files as the basis for the draft', async () => {
      (api.compareBranches as any).mockResolvedValue([
        { path: 'c4.txt', status: 'MODIFIED', additions: 1, deletions: 0 },
      ]);
      (api.compareCommits as any).mockResolvedValue([{ sha: 'aaa', title: 'commit 4' }]);
      renderForm();
      await pickSourceAndDraft();

      await waitFor(() => expect(streamAiChat).toHaveBeenCalled());
      const messages = (streamAiChat as any).mock.calls[0][0];
      const prompt = messages.map((m: any) => m.content).join('\n');
      expect(prompt).toContain('commit 4');
      expect(prompt).toContain('c4.txt');
      expect(prompt).toMatch(/only changes not yet in 'main'/);
    });

    it('refuses to draft when the branch is already fully merged', async () => {
      (api.compareBranches as any).mockResolvedValue([]);
      (api.compareCommits as any).mockResolvedValue([]);
      renderForm();
      await pickSourceAndDraft();

      expect(await screen.findByText(/nothing that is not already in 'main'/i)).toBeInTheDocument();
      expect(streamAiChat).not.toHaveBeenCalled();
    });
  });
});
