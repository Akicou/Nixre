import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Navbar } from './Navbar';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    listSpaces: vi.fn(),
  },
}));

const user = { id: 1, uid: 'me', email: 'me@nixre.dev', display_name: 'Me', admin: false };

describe('Navbar space switcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the space from the current URL, not always the first space in the list', async () => {
    (api.listSpaces as any).mockResolvedValue([
      { id: 1, uid: 'first-space', path: 'first-space', description: '', is_public: true, created: 0, created_by: 0, updated: 0 },
      { id: 2, uid: 'second-space', path: 'second-space', description: '', is_public: true, created: 0, created_by: 0, updated: 0 },
    ]);

    render(
      <MemoryRouter initialEntries={['/second-space/some-repo']}>
        <Navbar currentUser={user} onLogout={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('second-space')).toBeInTheDocument();
    });
  });

  it('falls back to the first space when the route is not a space page', async () => {
    (api.listSpaces as any).mockResolvedValue([
      { id: 1, uid: 'first-space', path: 'first-space', description: '', is_public: true, created: 0, created_by: 0, updated: 0 },
    ]);

    render(
      <MemoryRouter initialEntries={['/']}>
        <Navbar currentUser={user} onLogout={vi.fn()} />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('first-space')).toBeInTheDocument();
    });
  });
});
