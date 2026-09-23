import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../App';
import { user, adminUser, space, repo } from './fixtures';

// A complete mock of the api module so App and every page can run unmocked.
const { api } = vi.hoisted(() => ({
  api: {
    currentUser: vi.fn(),
    logout: vi.fn(),
    listSpaces: vi.fn(),
    listRepos: vi.fn(),
    getSpace: vi.fn(),
    getRepo: vi.fn(),
    getBranches: vi.fn(),
    getCommits: vi.fn(),
    getTree: vi.fn(),
    getRawBlob: vi.fn(),
    listPullRequests: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({ api }));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  api.listSpaces.mockResolvedValue([]);
  api.listRepos.mockResolvedValue([]);
  api.getSpace.mockResolvedValue(space);
  api.getRepo.mockResolvedValue(repo);
  api.getBranches.mockResolvedValue([]);
  api.getCommits.mockResolvedValue([]);
  api.getTree.mockResolvedValue([]);
  api.getRawBlob.mockRejectedValue(new Error('not found'));
  api.listPullRequests.mockResolvedValue([]);
});

describe('App routing & auth guards', () => {
  it('redirects guests to /login', async () => {
    api.currentUser.mockRejectedValue(new Error('Unauthorized'));
    render(<App />);
    await screen.findByText(/Sign in to Nixre/i);
  });

  it('lets guests open a public repository without logging in', async () => {
    api.currentUser.mockRejectedValue(new Error('Unauthorized'));
    window.history.pushState(null, '', `/${space.uid}/${repo.uid}`);
    render(<App />);
    await vi.waitFor(() => expect(api.getRepo).toHaveBeenCalledWith(`${space.uid}/${repo.uid}`));
    expect(window.location.pathname).toBe(`/${space.uid}/${repo.uid}`);
    expect(screen.queryByText(/Sign in to Nixre/i)).toBeNull();
    window.history.pushState(null, '', '/');
  });

  it('shows the dashboard for a signed-in user', async () => {
    api.currentUser.mockResolvedValue(user);
    render(<App />);
    await screen.findByText(/Repositories & Spaces/i);
  });

  it('serves the dashboard for an admin user', async () => {
    api.currentUser.mockResolvedValue(adminUser);
    render(<App />);
    await screen.findByText(/Repositories & Spaces/i);
  });
});
