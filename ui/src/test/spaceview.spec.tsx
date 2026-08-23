import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SpaceView } from '../pages/SpaceView';
import { space, repo } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: { getSpace: vi.fn(), listRepos: vi.fn() },
}));
vi.mock('../lib/api', () => ({ api }));

function mount(initialPath = '/acme') {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/:space" element={<SpaceView />} />
      </Routes>
    </MemoryRouter>
  );
  return render(<SpaceView />, { wrapper });
}

describe('SpaceView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSpace.mockResolvedValue(space);
    api.listRepos.mockResolvedValue([repo]);
  });

  it('renders the space header and its repositories', async () => {
    mount();
    expect(await screen.findByText('acme')).toBeInTheDocument();
    expect(await screen.findByText('Acme Corporation')).toBeInTheDocument();
    expect(await screen.findByText('website')).toBeInTheDocument();
  });

  it('shows an empty state when the space has no repositories', async () => {
    api.listRepos.mockResolvedValue([]);
    mount();
    expect(await screen.findByText(/No repositories yet/i)).toBeInTheDocument();
  });

  it('shows an error when the space cannot be loaded', async () => {
    api.getSpace.mockRejectedValue(new Error('not found'));
    mount();
    expect(await screen.findByText(/Space not found/)).toBeInTheDocument();
  });
});
