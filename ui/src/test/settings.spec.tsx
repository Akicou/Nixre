import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Settings } from '../pages/Settings';
import { user } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: {
    listPublicKeys: vi.fn(),
    listTokens: vi.fn(),
    addPublicKey: vi.fn(),
    deletePublicKey: vi.fn(),
    createToken: vi.fn(),
    deleteToken: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({ api }));
vi.mock('../lib/webauthn', () => ({
  WebAuthnService: { getRegisteredPasskeys: vi.fn().mockReturnValue([]) },
}));

function mount(initialPath = '/settings') {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/settings" element={<Settings user={user} />} />
      </Routes>
    </MemoryRouter>
  );
  return render(<Settings user={user} />, { wrapper });
}

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listPublicKeys.mockResolvedValue([]);
    api.listTokens.mockResolvedValue([]);
  });

  it('shows the profile by default', async () => {
    mount();
    expect(await screen.findByText('jane')).toBeInTheDocument();
    expect(screen.getByText('jane@nixre.dev')).toBeInTheDocument();
  });

  it('opens the passkeys tab from the URL hash', async () => {
    mount('/settings#passkeys');
    expect(await screen.findByText(/Passkeys & WebAuthn Credentials/)).toBeInTheDocument();
  });

  it('adds an SSH key', async () => {
    api.addPublicKey.mockResolvedValue({ id: 1, identifier: 'My Laptop', fingerprint: 'aa', content: 'ssh-ed25519 AAAA', created: 0 });
    mount();

    fireEvent.click(screen.getByRole('button', { name: /SSH Keys/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. My Laptop'), { target: { value: 'My Laptop' } });
    fireEvent.change(screen.getByPlaceholderText(/Begins with 'ssh-ed25519'/), { target: { value: 'ssh-ed25519 AAAA' } });
    fireEvent.click(screen.getByRole('button', { name: /Add SSH Key/ }));

    await waitFor(() => {
      expect(api.addPublicKey).toHaveBeenCalledWith('My Laptop', 'ssh-ed25519 AAAA');
    });
    expect(await screen.findByText(/SSH Key added successfully/)).toBeInTheDocument();
  });

  it('generates a personal access token', async () => {
    api.createToken.mockResolvedValue({ access_token: 'secret-token', token: { identifier: 'CI', type: 'pat', issued_at: 0, expires_at: 0 } });
    mount();

    fireEvent.click(screen.getByRole('button', { name: /Access Tokens/ }));
    fireEvent.change(screen.getByPlaceholderText(/Token name/), { target: { value: 'CI' } });
    fireEvent.click(screen.getByRole('button', { name: /Generate Token/ }));

    await waitFor(() => {
      expect(api.createToken).toHaveBeenCalledWith('CI', expect.any(Number));
    });
    expect(await screen.findByText('secret-token')).toBeInTheDocument();
  });
});
