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
    updateSpace: vi.fn(),
    addSpaceMember: vi.fn(),
    updateSpaceMember: vi.fn(),
    removeSpaceMember: vi.fn(),
    transferSpace: vi.fn(),
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

const members = [
  { uid: 'jane', display_name: 'Jane Doe', role: 'owner', avatar_url: '' },
  { uid: 'bob', display_name: 'Bob Builder', role: 'member', avatar_url: '' },
];

describe('SpaceView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSpace.mockResolvedValue(space);
    api.listRepos.mockResolvedValue([repo]);
    api.getContributions.mockResolvedValue(emptyContrib);
    api.listSpaceMembers.mockResolvedValue(members);
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

  it('lists org people with names and roles', async () => {
    mount();
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('Bob Builder')).toBeInTheDocument();
    expect(screen.getAllByText('Owner').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Member').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /People/ }));
    expect(await screen.findByText(/2 people/)).toBeInTheDocument();
    expect(screen.queryByText('Add member')).not.toBeInTheDocument();
    expect(screen.queryByText('Transfer ownership')).not.toBeInTheDocument();
  });

  it('lets an owner invite, edit the org, and transfer it', async () => {
    api.getSpace.mockResolvedValue({
      ...space,
      is_member: true,
      role: 'owner',
      can_manage: true,
      can_transfer: true,
    });
    api.addSpaceMember.mockResolvedValue([
      ...members,
      { uid: 'sam', display_name: 'Sam', role: 'member', avatar_url: '' },
    ]);
    api.updateSpace.mockResolvedValue({
      ...space,
      description: 'Updated corp',
      is_member: true,
      role: 'owner',
      can_manage: true,
      can_transfer: true,
    });
    api.transferSpace.mockResolvedValue({
      space: { ...space, role: 'admin', can_manage: true, can_transfer: false },
      members: [
        { uid: 'bob', display_name: 'Bob Builder', role: 'owner', avatar_url: '' },
        { uid: 'jane', display_name: 'Jane Doe', role: 'admin', avatar_url: '' },
      ],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    mount();
    expect(await screen.findByText('Edit organization')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /People/ }));
    expect(await screen.findByText('Add member')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('username'), { target: { value: 'sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((await screen.findAllByText('Sam')).length).toBeGreaterThan(0);
    expect(api.addSpaceMember).toHaveBeenCalledWith('acme', 'sam', 'member');

    fireEvent.change(screen.getByPlaceholderText('new owner username'), { target: { value: 'bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    expect(await screen.findByText(/Ownership transferred to bob/)).toBeInTheDocument();
    expect(api.transferSpace).toHaveBeenCalledWith('acme', 'bob');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const desc = await screen.findByDisplayValue('Acme Corporation');
    fireEvent.change(desc, { target: { value: 'Updated corp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Organization saved.')).toBeInTheDocument();
    expect(api.updateSpace).toHaveBeenCalledWith('acme', { description: 'Updated corp', is_public: true });
    vi.restoreAllMocks();
  });

  it('hides org people and settings on a personal profile', async () => {
    api.getSpace.mockResolvedValue({ ...space, uid: 'jane', path: 'jane', is_personal: true, description: '' });
    api.getUserProfile.mockResolvedValue({
      uid: 'jane',
      display_name: 'Jane Doe',
      email: 'jane@nixre.dev',
      is_self: true,
      is_admin: false,
      bio: '',
      is_public: true,
      avatar: 'JA',
      socials: [],
      created: 1_700_000_000_000,
      orgs: [],
      repos: [],
    });
    mount('/jane');
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /People/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByText('Edit organization')).not.toBeInTheDocument();
  });
});
