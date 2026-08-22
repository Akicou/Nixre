import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NewRepo } from '../pages/NewRepo';
import { NewSpace } from '../pages/NewSpace';
import { space, repo } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: { listSpaces: vi.fn(), createRepo: vi.fn(), createSpace: vi.fn() },
}));
vi.mock('../lib/api', () => ({ api }));

describe('NewRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listSpaces.mockResolvedValue([space]);
  });

  function mount() {
    return render(
      <MemoryRouter>
        <NewRepo />
      </MemoryRouter>,
    );
  }

  it('creates a repository with the selected space', async () => {
    api.createRepo.mockResolvedValue(repo);
    mount();

    await screen.findByText('acme');
    fireEvent.change(screen.getByPlaceholderText('e.g. awesome-app'), { target: { value: 'website' } });
    fireEvent.change(screen.getByPlaceholderText(/Short description/), { target: { value: 'desc' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Repository/i }));

    await waitFor(() => {
      expect(api.createRepo).toHaveBeenCalledWith('acme', 'website', 'desc', true, true, 'main');
    });
  });

  it('shows an error when creation fails', async () => {
    api.createRepo.mockRejectedValue(new Error('disk full'));
    mount();

    await screen.findByText('acme');
    fireEvent.change(screen.getByPlaceholderText('e.g. awesome-app'), { target: { value: 'website' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Repository/i }));

    expect(await screen.findByText(/disk full/)).toBeInTheDocument();
  });
});

describe('NewSpace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mount() {
    return render(
      <MemoryRouter>
        <NewSpace />
      </MemoryRouter>,
    );
  }

  it('creates a space', async () => {
    api.createSpace.mockResolvedValue(space);
    mount();

    fireEvent.change(screen.getByPlaceholderText('e.g. my-team'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByPlaceholderText(/Description of this space/), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Space/i }));

    await waitFor(() => {
      expect(api.createSpace).toHaveBeenCalledWith('acme', 'Acme', false);
    });
  });

  it('shows an error when creation fails', async () => {
    api.createSpace.mockRejectedValue(new Error('space exists'));
    mount();

    fireEvent.change(screen.getByPlaceholderText('e.g. my-team'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Space/i }));

    expect(await screen.findByText(/space exists/)).toBeInTheDocument();
  });
});
