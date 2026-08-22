import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Navbar } from '../components/Navbar';
import { user, adminUser } from './fixtures';

const { api, isPluginLive } = vi.hoisted(() => ({
  api: { listSpaces: vi.fn() },
  isPluginLive: vi.fn(),
}));
vi.mock('../lib/api', () => ({ api }));
vi.mock('../lib/pluginPreferences', () => ({ isPluginLive }));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  api.listSpaces.mockResolvedValue([]);
  isPluginLive.mockResolvedValue(false);
});

function mount(currentUser = user, onLogout = vi.fn()) {
  return render(
    <MemoryRouter>
      <Navbar currentUser={currentUser} onLogout={onLogout} />
    </MemoryRouter>,
  );
}

describe('Navbar theme toggle', () => {
  it('switches between dark and light themes', () => {
    mount();
    const toggle = screen.getByRole('button', { name: /Toggle Dark\/Light Mode/ });
    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('nixre_theme')).toBe('light');
  });
});

describe('Navbar user menu', () => {
  it('does not show the admin console for non-admin users', async () => {
    mount(user);
    fireEvent.click(screen.getByText('jane').closest('button')!);
    expect(await screen.findByText(/Settings & Profile/)).toBeInTheDocument();
    expect(screen.queryByText(/Admin Console/)).toBeNull();
  });

  it('shows the admin console for admin users', async () => {
    mount(adminUser);
    fireEvent.click(screen.getByText('admin').closest('button')!);
    expect(await screen.findByText(/Admin Console/)).toBeInTheDocument();
  });

  it('calls onLogout when Sign Out is clicked', async () => {
    const onLogout = vi.fn();
    mount(user, onLogout);
    fireEvent.click(screen.getByText('jane').closest('button')!);
    fireEvent.click(await screen.findByText(/Sign Out/));
    await waitFor(() => expect(onLogout).toHaveBeenCalled());
  });
});

describe('Navbar Agent link', () => {
  it('hides the Agent workspace when the assistant plugin is not live', async () => {
    mount();
    await waitFor(() => expect(isPluginLive).toHaveBeenCalledWith('nixre-assistant'));
    expect(screen.queryByTitle('Agentic engineering workspace')).toBeNull();
  });

  it('shows the Agent workspace when the assistant plugin is live', async () => {
    isPluginLive.mockResolvedValue(true);
    mount();
    expect(await screen.findByTitle('Agentic engineering workspace')).toHaveAttribute('href', '/agent');
  });
});
