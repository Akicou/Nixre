import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RepoSettingsPanel } from '../components/RepoSettingsPanel';
import { repo } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: { updateRepo: vi.fn(), deleteRepo: vi.fn() },
}));
vi.mock('../lib/api', () => ({ api }));

function mount(onUpdated = vi.fn()) {
  return render(
    <MemoryRouter>
      <RepoSettingsPanel
        repo={repo}
        repoPath="acme/website"
        space="acme"
        onUpdated={onUpdated}
      />
    </MemoryRouter>,
  );
}

describe('RepoSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the current repository settings', async () => {
    mount();
    expect(await screen.findByDisplayValue('The Acme marketing website')).toBeInTheDocument();
  });

  it('saves an updated description and visibility', async () => {
    const onUpdated = vi.fn();
    api.updateRepo.mockResolvedValue({ ...repo, description: 'New description', is_public: false });
    mount(onUpdated);

    fireEvent.change(screen.getByPlaceholderText(/Short description/), { target: { value: 'New description' } });
    fireEvent.click(screen.getByRole('button', { name: /Private/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));

    await waitFor(() => {
      expect(api.updateRepo).toHaveBeenCalledWith('acme/website', { description: 'New description', is_public: false });
    });
    expect(await screen.findByText(/Repository settings saved/)).toBeInTheDocument();
    expect(onUpdated).toHaveBeenCalled();
  });

  it('shows an error when saving fails', async () => {
    api.updateRepo.mockRejectedValue(new Error('forbidden'));
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
  });

  it('requires the repository name before deletion is allowed', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Delete repository/ }));

    const confirmInput = await screen.findByPlaceholderText('website');
    const deleteBtn = screen.getByRole('button', { name: /Delete permanently/ });
    expect(deleteBtn).toBeDisabled();

    fireEvent.change(confirmInput, { target: { value: 'website' } });
    expect(deleteBtn).toBeEnabled();
  });

  it('deletes the repository', async () => {
    api.deleteRepo.mockResolvedValue(undefined);
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Delete repository/ }));
    fireEvent.change(await screen.findByPlaceholderText('website'), { target: { value: 'website' } });
    fireEvent.click(screen.getByRole('button', { name: /Delete permanently/ }));

    await waitFor(() => {
      expect(api.deleteRepo).toHaveBeenCalledWith('acme/website');
    });
  });
});
