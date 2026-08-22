import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Login } from './Login';
import { WebAuthnService } from '../lib/webauthn';

vi.mock('../lib/api', () => ({
  api: {
    login: vi.fn(),
    currentUser: vi.fn(),
  },
}));

vi.mock('../lib/webauthn', () => ({
  WebAuthnService: {
    loginWithPasskey: vi.fn(),
  },
}));

describe('Login passkey flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('stores the session token from the server-verified ceremony and signs in', async () => {
    const onLoginSuccess = vi.fn();
    const user = { uid: 'real', email: 'real@nixre.dev', display_name: 'Real', admin: false };
    (WebAuthnService.loginWithPasskey as any).mockResolvedValue({
      token: 'nxs_session_token',
      user,
    });

    render(
      <MemoryRouter>
        <Login onLoginSuccess={onLoginSuccess} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText(/Sign in with Passkey/i));

    await waitFor(() => {
      expect(onLoginSuccess).toHaveBeenCalledWith(expect.objectContaining({ uid: 'real' }));
    });
    expect(localStorage.getItem('nixre_token')).toBe('nxs_session_token');
  });

  it('shows the server error when the ceremony is rejected', async () => {
    const onLoginSuccess = vi.fn();
    (WebAuthnService.loginWithPasskey as any).mockRejectedValue(
      new Error("No passkeys registered for 'nobody' on git.example.com. Register one in Settings → Passkeys after signing in."),
    );

    render(
      <MemoryRouter>
        <Login onLoginSuccess={onLoginSuccess} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText(/Sign in with Passkey/i));

    await waitFor(() => {
      expect(screen.getByText(/no passkeys registered/i)).toBeInTheDocument();
    });
    expect(onLoginSuccess).not.toHaveBeenCalled();
    expect(localStorage.getItem('nixre_token')).toBeNull();
  });
});
