import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminView } from '../pages/AdminView';
import { user, adminUser } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: {
    listUsers: vi.fn(),
    getRegistrationStatus: vi.fn(),
    setRegistrationClosed: vi.fn(),
    listEnvFeedback: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({ api }));

function mount() {
  return render(
    <MemoryRouter>
      <AdminView />
    </MemoryRouter>,
  );
}

describe('AdminView', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    api.listUsers.mockResolvedValue([user, adminUser]);
    api.getRegistrationStatus.mockResolvedValue({ closed: false });
    api.listEnvFeedback.mockResolvedValue([]);
  });

  it('lists registered accounts', async () => {
    mount();
    expect(await screen.findByText(/@jane/)).toBeInTheDocument();
    expect(await screen.findByText(/@admin/)).toBeInTheDocument();
  });

  it('toggles the client-side registration page lock', async () => {
    mount();
    const toggle = await screen.findByRole('button', { name: /Hide Registration Page/ });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(localStorage.getItem('nixre_registration_hidden')).toBe('true');
    });
    expect(await screen.findByRole('button', { name: /Show Registration Page/ })).toBeInTheDocument();
  });

  it('shows the real server-side registration state and closes it via the API', async () => {
    mount();
    expect(await screen.findByText(/OPEN/)).toBeInTheDocument();

    api.setRegistrationClosed.mockResolvedValue({ closed: true });
    fireEvent.click(await screen.findByRole('button', { name: /Close Registration/ }));

    await waitFor(() => {
      expect(api.setRegistrationClosed).toHaveBeenCalledWith(true);
    });
    expect(await screen.findByText(/CLOSED/)).toBeInTheDocument();
    expect(await screen.findByText(/Registration is now closed server-side/)).toBeInTheDocument();
  });

  it('shows an empty state for environment reports', async () => {
    mount();
    expect(await screen.findByText(/No sandbox reports yet/i)).toBeInTheDocument();
  });

  it('lists a filed environment report and expands the details', async () => {
    api.listEnvFeedback.mockResolvedValue([
      {
        id: 'envfb_1',
        user_id: 'lyan',
        conversation_id: 'conv_1',
        repo_path: 'acme/website',
        created_at: '2026-08-25T00:00:00.000Z',
        report: {
          missing_binaries: ['rg', 'jq'],
          missing_packages: [],
          missing_nixre_tools: [],
          permission_gaps: ['web_search'],
          dockerfile_suggestions: ['apt-get install -y ripgrep jq'],
          notes: 'Need ripgrep in the slim image',
        },
      },
    ]);
    mount();
    expect(await screen.findByText(/Need ripgrep in the slim image/)).toBeInTheDocument();
    expect(screen.getByText(/lyan · acme\/website/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/lyan · acme\/website/));
    expect(await screen.findByText('rg')).toBeInTheDocument();
    expect(screen.getByText('web_search')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in Agent/ })).toHaveAttribute(
      'href',
      '/agent?repo=acme%2Fwebsite',
    );
  });
});
