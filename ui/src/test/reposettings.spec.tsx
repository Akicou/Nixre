import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RepoSettings } from '../pages/RepoSettings';
import { repo } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: { getRepo: vi.fn(), updateRepo: vi.fn(), deleteRepo: vi.fn() },
}));
vi.mock('../lib/api', () => ({ api }));

function mount(initialPath = '/acme/website/settings') {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/:space/:repo/settings" element={<RepoSettings />} />
      </Routes>
    </MemoryRouter>
  );
  return render(<RepoSettings />, { wrapper });
}

describe('RepoSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getRepo.mockResolvedValue(repo);
  });

  it('loads and shows the current repository settings', async () => {
    mount();
    expect(await screen.findByText(/Repository Settings/)).toBeInTheDocument();
    expect(await screen.findByDisplayValue('The Acme marketing website')).toBeInTheDocument();
    expect(await screen.findByText('acme/website')).toBeInTheDocument();
  });

  it('saves an updated description and visibility', async () => {
    api.updateRepo.mockResolvedValue({ ...repo, description: 'New description', is_public: false });
    mount();

    await screen.findByDisplayValue('The Acme marketing website');
    fireEvent.change(screen.getByPlaceholderText(/Short description/), { target: { value: 'New description' } });
    fireEvent.click(screen.getByRole('button', { name: /Private/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));

    await waitFor(() => {
      expect(api.updateRepo).toHaveBeenCalledWith('acme/website', { description: 'New description', is_public: false });
    });
    expect(await screen.findByText(/Repository settings saved/)).toBeInTheDocument();
  });

  it('shows an error when saving fails', async () => {
    api.updateRepo.mockRejectedValue(new Error('forbidden'));
    mount();

    await screen.findByDisplayValue('The Acme marketing website');
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));

    expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
  });

  it('requires the repository name before deletion is allowed', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Delete repository/ }));

    const confirmInput = await screen.findByPlaceholderText('website');
    const deleteBtn = screen.getByRole('button', { name: /Delete permanently/ });
    expect(deleteBtn).toBeDisabled();

    fireEvent.change(confirmInput, { target: { value: 'website' } });
    expect(deleteBtn).toBeEnabled();
  });

  it('deletes the repository and navigates back to the space', async () => {
    api.deleteRepo.mockResolvedValue(undefined);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: /Delete repository/ }));
    fireEvent.change(await screen.findByPlaceholderText('website'), { target: { value: 'website' } });
    fireEvent.click(screen.getByRole('button', { name: /Delete permanently/ }));

    await waitFor(() => {
      expect(api.deleteRepo).toHaveBeenCalledWith('acme/website');
    });
  });
});
