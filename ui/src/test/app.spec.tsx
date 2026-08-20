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
});

describe('App routing & auth guards', () => {
  it('redirects guests to /login', async () => {
    api.currentUser.mockRejectedValue(new Error('Unauthorized'));
    render(<App />);
    await screen.findByText(/Sign in to Nixre/i);
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
