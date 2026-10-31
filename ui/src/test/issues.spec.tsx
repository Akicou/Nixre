import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IssuesPanel } from '../components/IssuesPanel';

const { api } = vi.hoisted(() => ({
  api: {
    listIssues: vi.fn(),
    getIssue: vi.fn(),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    commentOnIssue: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({ api }));

const issue = {
  number: 3, title: 'Upgrade node', body: 'Fix **now**', state: 'open', labels: ['security'],
  source: 'security-scan', author: { uid: 'bot', display_name: 'Security scan' },
  created: 1, updated: 1, comment_count: 0,
};

describe('IssuesPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists issues with the security-scan badge and hides New Issue from read-only users', async () => {
    api.listIssues.mockResolvedValue([issue]);
    render(<IssuesPanel repoPath="acme/web" canWrite={false} signedIn={false} selected={null} onSelect={vi.fn()} />);
    expect(await screen.findByText('Upgrade node')).toBeInTheDocument();
    expect(screen.getByText('security scan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New Issue/ })).toBeNull();
  });

  it('creates an issue and selects it', async () => {
    api.createIssue.mockResolvedValue(issue);
    const onSelect = vi.fn();
    render(<IssuesPanel repoPath="acme/web" canWrite signedIn selected="new" onSelect={onSelect} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: ' Upgrade node ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
    await waitFor(() => expect(api.createIssue).toHaveBeenCalledWith('acme/web', 'Upgrade node', ''));
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('closes an issue and posts a comment from the detail view', async () => {
    api.getIssue.mockResolvedValue({ issue, comments: [] });
    api.updateIssue.mockResolvedValue({ ...issue, state: 'closed' });
    api.commentOnIssue.mockResolvedValue({
      id: 1, body: 'done', author: { uid: 'u', display_name: 'Jane' }, source: 'user', created: 2,
    });
    render(<IssuesPanel repoPath="acme/web" canWrite signedIn selected={3} onSelect={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close issue' }));
    expect(await screen.findByRole('button', { name: 'Reopen issue' })).toBeInTheDocument();
    expect(api.updateIssue).toHaveBeenCalledWith('acme/web', 3, { state: 'closed' });

    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'done' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByText('done')).toBeInTheDocument();
  });
});
