import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Login } from '../pages/Login';
import { Register } from '../pages/Register';
import { user } from './fixtures';

const { api } = vi.hoisted(() => ({
  api: {
    login: vi.fn(),
    register: vi.fn(),
    currentUser: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({ api }));

// WebAuthn is exercised separately in Login.test.tsx; here we stub it.
vi.mock('../lib/webauthn', () => ({
  WebAuthnService: { authenticatePasskey: vi.fn() },
}));

describe('Login password flow', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  function mount(onLoginSuccess = vi.fn()) {
    return render(
      <MemoryRouter>
        <Login onLoginSuccess={onLoginSuccess} />
      </MemoryRouter>,
    );
  }

  it('logs in with a username and password', async () => {
    const onLoginSuccess = vi.fn();
    api.login.mockResolvedValue({ access_token: 'tok', user });
    mount(onLoginSuccess);

    fireEvent.change(screen.getByPlaceholderText('e.g. jsmith'), { target: { value: 'jane' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => {
      expect(api.login).toHaveBeenCalledWith('jane', 'secret');
      expect(onLoginSuccess).toHaveBeenCalledWith(user);
    });
  });

  it('shows an error when credentials are rejected', async () => {
    api.login.mockRejectedValue(new Error('Invalid credentials'));
    mount();

    fireEvent.change(screen.getByPlaceholderText('e.g. jsmith'), { target: { value: 'jane' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(await screen.findByText(/Invalid credentials/)).toBeInTheDocument();
  });
});

describe('Register flow', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  function mount(onRegisterSuccess = vi.fn()) {
    return render(
      <MemoryRouter>
        <Register onRegisterSuccess={onRegisterSuccess} />
      </MemoryRouter>,
    );
  }

  // The Register page has two inputs with the 'e.g. jsmith' placeholder
  // (username/UID and display name); the first is the UID.
  function fillForm() {
    fireEvent.change(screen.getAllByPlaceholderText('e.g. jsmith')[0], { target: { value: 'jane' } });
    fireEvent.change(screen.getByPlaceholderText('user@nixre.dev'), { target: { value: 'jane@nixre.dev' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Account/i }));
  }

  it('registers a new account', async () => {
    const onRegisterSuccess = vi.fn();
    api.register.mockResolvedValue({ access_token: 'tok', user });
    mount(onRegisterSuccess);
    fillForm();

    await waitFor(() => {
      expect(api.register).toHaveBeenCalledWith('jane', 'jane@nixre.dev', 'jane', 'secret');
      expect(onRegisterSuccess).toHaveBeenCalledWith(user);
    });
  });

  it('shows an error when registration fails', async () => {
    api.register.mockRejectedValue(new Error('uid already taken'));
    mount();
    fillForm();

    expect(await screen.findByText(/uid already taken/)).toBeInTheDocument();
  });

  it('blocks the form when registration is hidden in this browser', async () => {
    localStorage.setItem('nixre_registration_hidden', 'true');
    mount();
    expect(await screen.findByText(/Public Registration is Closed/)).toBeInTheDocument();
  });
});
