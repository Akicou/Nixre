import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '../pages/Dashboard';
import { user, space, repo } from './fixtures';
import type { ActivityFeed } from '../lib/api';

const { api } = vi.hoisted(() => ({
  api: { listSpaces: vi.fn(), listRepos: vi.fn(), getActivity: vi.fn() },
}));
vi.mock('../lib/api', () => ({ api }));

const now = Date.now();
const feed: ActivityFeed = {
  window_days: 30,
  events: [
    {
      id: 'push:1', kind: 'push', at: now - 5 * 60_000, repo: 'acme/website', count: 4,
      actor: { uid: 'ada', display_name: 'Ada Lovelace', avatar_url: '' },
      commits: [
        { sha: 'a'.repeat(40), short_sha: 'aaaaaaa', title: 'Add pricing page' },
        { sha: 'b'.repeat(40), short_sha: 'bbbbbbb', title: 'Fix nav overflow' },
      ],
    },
    {
      id: 'pr:1:7:merge', kind: 'pr_merged', at: now - 60 * 60_000, repo: 'acme/website', number: 7,
      title: 'Dark mode', draft: false, actor: { uid: 'bob', display_name: 'Bob', avatar_url: '' },
    },
    {
      id: 'deploy:9', kind: 'deploy_failed', at: now - 2 * 60 * 60_000, repo: 'acme/website', actor: null,
      service: 'web', ref: 'main', short_sha: 'ccccccc', trigger: 'push', duration_ms: 4200,
    },
  ],
  daily: Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, commits: i, prs: i % 3, other: 1 })),
  contributors: [
    { uid: 'ada', display_name: 'Ada Lovelace', avatar_url: '', count: 4, commits: 4, prs: 0 },
    { uid: 'bob', display_name: 'Bob', avatar_url: '', count: 1, commits: 0, prs: 1 },
  ],
  stats: { repos: 1, open_prs: 3, commits_7d: 12, contributors_7d: 2, live_services: 0, members: 5 },
};

function mount(path = '/?tab=repos') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Dashboard user={user} />
    </MemoryRouter>,
  );
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listSpaces.mockResolvedValue([space]);
    api.listRepos.mockResolvedValue([repo]);
    api.getActivity.mockResolvedValue(feed);
  });

  it('renders repositories and spaces', async () => {
    mount();
    expect(await screen.findByText('acme/website')).toBeInTheDocument();
    expect(await screen.findByText('The Acme marketing website')).toBeInTheDocument();
    // Sidebar space entry
    expect(await screen.findByText('acme')).toBeInTheDocument();
  });

  it('shows uploaded org avatars in the namespaces list', async () => {
    api.listSpaces.mockResolvedValue([
      { ...space, avatar_url: '/api/v1/avatars/space/acme' },
    ]);
    mount();
    const img = await screen.findByAltText('acme');
    expect(img).toHaveAttribute('src', '/api/v1/avatars/space/acme');
  });

  it('filters repositories by search text', async () => {
    mount();
    await screen.findByText('acme/website');
    const input = screen.getByPlaceholderText(/Filter repositories/i);
    fireEvent.change(input, { target: { value: 'nomatch' } });
    await waitFor(() => {
      expect(screen.getByText(/No repositories found/)).toBeInTheDocument();
    });
  });

  it('shows the empty state when there are no repositories', async () => {
    api.listRepos.mockResolvedValue([]);
    mount();
    expect(await screen.findByText(/No repositories found/)).toBeInTheDocument();
    expect(screen.getByText(/Create Repository/)).toBeInTheDocument();
  });

  it('opens on the activity feed with grouped pushes, PRs and deploys', async () => {
    mount('/');
    expect(await screen.findByText('Add pricing page')).toBeInTheDocument();
    expect(screen.getByText(/pushed 4 commits to/)).toBeInTheDocument();
    expect(screen.getByText('+ 2 more')).toBeInTheDocument();
    expect(screen.getByText('Dark mode')).toBeInTheDocument();
    expect(screen.getByText(/failed to deploy from/)).toBeInTheDocument();
    // Commit rows deep-link into the repo's commit view.
    expect(screen.getByText('Add pricing page').closest('a')).toHaveAttribute(
      'href', `/acme/website?tab=commits&commit=${'a'.repeat(40)}`,
    );
    // Repositories live behind their own tab.
    expect(screen.queryByPlaceholderText(/Filter repositories/i)).not.toBeInTheDocument();
  });

  it('shows the hero stats, 30-day chart and leaderboard', async () => {
    mount('/');
    const hero = await screen.findByTestId('activity-pulse');
    expect(hero).toHaveTextContent(/Good|Burning the midnight oil/);
    await waitFor(() => expect(screen.getAllByTestId('activity-bar')).toHaveLength(30));
    expect(hero).toHaveTextContent('12');
    expect(hero).toHaveTextContent('of 5');
    const board = screen.getByTestId('top-contributors');
    expect(board).toHaveTextContent('Ada Lovelace');
    expect(board).toHaveTextContent('4 commits');
  });

  it('keeps "active of N" about accounts and reports outside committers apart', async () => {
    api.getActivity.mockResolvedValue({
      ...feed,
      stats: { ...feed.stats, contributors_7d: 1, external_contributors_7d: 1, members: 1 },
    });
    mount('/');
    const hero = await screen.findByTestId('activity-pulse');
    // One account active out of one, plus one git author with no account: never "2 of 1".
    expect(hero).toHaveTextContent(/1\s*of 1 · \+1 outside/);
    expect(hero).not.toHaveTextContent('2 of 1');
  });

  it('filters the feed by kind', async () => {
    mount('/');
    await screen.findByText('Add pricing page');
    fireEvent.click(screen.getByRole('tab', { name: /Pull requests/ }));
    expect(screen.queryByText('Add pricing page')).not.toBeInTheDocument();
    expect(screen.getByText('Dark mode')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
    expect(screen.getByText('Nothing here in the last 30 days')).toBeInTheDocument();
  });

  it('switches to repositories from the tab bar', async () => {
    mount('/');
    await screen.findByText('Add pricing page');
    fireEvent.click(screen.getByRole('tab', { name: /Repositories/ }));
    expect(await screen.findByPlaceholderText(/Filter repositories/i)).toBeInTheDocument();
  });

  it('still renders when the activity endpoint fails', async () => {
    api.getActivity.mockRejectedValue(new Error('404'));
    mount('/');
    expect(await screen.findByText(/Couldn’t load activity/)).toBeInTheDocument();
  });

  it('lands guests on the repository list, with activity one tab away', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Dashboard user={null} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('acme/website')).toBeInTheDocument();
    expect(await screen.findByTestId('activity-pulse')).toHaveTextContent('What’s happening on this forge');
    fireEvent.click(screen.getByRole('tab', { name: /Activity/ }));
    expect(await screen.findByText('Add pricing page')).toBeInTheDocument();
  });
});
