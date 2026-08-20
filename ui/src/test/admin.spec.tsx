import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminView } from '../pages/AdminView';
import { user, adminUser } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: { listUsers: vi.fn() },
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
});
