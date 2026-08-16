import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Login } from './Login';
import { api } from '../lib/api';
import { WebAuthnService } from '../lib/webauthn';

vi.mock('../lib/api', () => ({
  api: {
    login: vi.fn(),
    currentUser: vi.fn(),
  },
}));

vi.mock('../lib/webauthn', () => ({
  WebAuthnService: {
    authenticatePasskey: vi.fn(),
  },
}));

describe('Login passkey flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not fabricate an admin user when currentUser() fails after passkey auth', async () => {
    const onLoginSuccess = vi.fn();
    (WebAuthnService.authenticatePasskey as any).mockResolvedValue({
      passkey: { id: 'abc', name: 'Test Key', userUid: 'someone', userEmail: '', createdAt: Date.now() },
    });
    (api.currentUser as any).mockRejectedValue(new Error('Unauthorized'));

    render(
      <MemoryRouter>
        <Login onLoginSuccess={onLoginSuccess} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText(/Sign in with Passkey/i));

    await waitFor(() => {
      expect(screen.getByText(/sign in with your password/i)).toBeInTheDocument();
    });

    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it('logs in with the real user when a session already exists', async () => {
    const onLoginSuccess = vi.fn();
    const realUser = { id: 7, uid: 'real', email: 'real@nixre.dev', display_name: 'Real', admin: false };
    (WebAuthnService.authenticatePasskey as any).mockResolvedValue({
      passkey: { id: 'abc', name: 'Test Key', userUid: 'real', userEmail: '', createdAt: Date.now() },
    });
    (api.currentUser as any).mockResolvedValue(realUser);

    render(
      <MemoryRouter>
        <Login onLoginSuccess={onLoginSuccess} />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText(/Sign in with Passkey/i));

    await waitFor(() => {
      expect(onLoginSuccess).toHaveBeenCalledWith(realUser);
    });
  });
});
