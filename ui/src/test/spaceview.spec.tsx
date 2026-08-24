import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SpaceView } from '../pages/SpaceView';
import { space, repo } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: {
    getSpace: vi.fn(),
    listRepos: vi.fn(),
    getUserProfile: vi.fn(),
    getRawBlob: vi.fn(),
    getContributions: vi.fn(),
    listSpaceMembers: vi.fn(),
    getUserGoals: vi.fn(),
  },
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

const emptyContrib = { year: 2026, total: 0, days: [] };

describe('SpaceView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSpace.mockResolvedValue(space);
    api.listRepos.mockResolvedValue([repo]);
    api.getContributions.mockResolvedValue(emptyContrib);
    api.listSpaceMembers.mockResolvedValue([]);
    api.getUserGoals.mockResolvedValue({ goals: [] });
    api.getUserProfile.mockRejectedValue(new Error('not a user'));
    api.getRawBlob.mockRejectedValue(new Error('no readme'));
  });

  it('renders the space header and its repositories', async () => {
    mount();
    expect(await screen.findByText('acme')).toBeInTheDocument();
    expect(await screen.findByText('Acme Corporation')).toBeInTheDocument();
    expect(await screen.findByText('website')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Repositories/ })).toBeInTheDocument();
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

  it('switches to the repositories tab', async () => {
    api.getSpace.mockResolvedValue({ ...space, is_member: true });
    mount();
    await screen.findByText('website');
    fireEvent.click(screen.getByRole('button', { name: /Repositories/ }));
    expect(await screen.findByText('New repository')).toBeInTheDocument();
    expect(screen.getByText('website')).toBeInTheDocument();
  });

  it('renders a personal profile with display name and heatmap', async () => {
    api.getSpace.mockResolvedValue({ ...space, uid: 'jane', path: 'jane', is_personal: true, description: '' });
    api.getUserProfile.mockResolvedValue({
      uid: 'jane',
      display_name: 'Jane Doe',
      email: 'jane@nixre.dev',
      is_self: true,
      is_admin: false,
      bio: 'Builds software.',
      is_public: true,
      avatar: 'JA',
      socials: [],
      created: 1_700_000_000_000,
      orgs: [{ uid: 'acme', avatar_url: '' }],
      repos: [],
    });
    api.getContributions.mockResolvedValue({ year: 2026, total: 12, days: [{ date: '2026-01-01', count: 12 }] });
    api.listRepos.mockResolvedValue([{ ...repo, uid: 'notes', path: 'jane/notes' }]);
    mount('/jane');
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Builds software.')).toBeInTheDocument();
    expect(screen.getByText('Edit profile')).toBeInTheDocument();
    expect(await screen.findByText(/12 contributions in 2026/)).toBeInTheDocument();
    expect(screen.getByText('notes')).toBeInTheDocument();
  });
});
