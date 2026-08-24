import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '../pages/Dashboard';
import { user, space, repo } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: { listSpaces: vi.fn(), listRepos: vi.fn() },
}));
vi.mock('../lib/api', () => ({ api }));

function mount() {
  return render(
    <MemoryRouter>
      <Dashboard user={user} />
    </MemoryRouter>,
  );
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listSpaces.mockResolvedValue([space]);
    api.listRepos.mockResolvedValue([repo]);
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
});
