import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RepositoryHeader } from '../components/RepositoryHeader';
import { repo } from './fixtures';

const live = vi.hoisted(() => ({ value: true }));
vi.mock('../lib/pluginPreferences', () => ({ isPluginLive: () => Promise.resolve(live.value) }));

const mount = (signedIn: boolean) =>
  render(
    <MemoryRouter>
      <RepositoryHeader repo={repo as never} space="acme" branchCount={1} signedIn={signedIn} />
    </MemoryRouter>,
  );

describe('Ask the agent button', () => {
  beforeEach(() => { live.value = true; });

  it('opens the agent workspace on this repo for signed-in users when the assistant is on', async () => {
    mount(true);
    const link = await screen.findByRole('link', { name: /Ask the agent/ });
    expect(link).toHaveAttribute('href', '/agent?repo=acme%2Fwebsite');
  });

  it('is hidden when the assistant plugin is off', async () => {
    live.value = false;
    mount(true);
    await waitFor(() => expect(screen.getByRole('button', { name: /Star/ })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /Ask the agent/ })).not.toBeInTheDocument();
  });

  it('is hidden for signed-out visitors', () => {
    mount(false);
    expect(screen.queryByRole('link', { name: /Ask the agent/ })).not.toBeInTheDocument();
  });
});
