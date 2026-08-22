import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Plugins } from '../pages/Plugins';
import { isPluginLive, isPluginAvailable } from '../lib/pluginPreferences';
import { installSyncFetchMock, syncMockReset } from './syncMock';

installSyncFetchMock();

function mount() {
  return render(<Plugins />);
}

// Locate the light-switch inside a specific plugin card (the plugin name also
// appears in the operator-availability card, so scope to the card by its
// unique description). Walks up from the description until the ancestor holds
// exactly one switch.
function pluginSwitch(description: string): HTMLButtonElement {
  const desc = screen.getByText(new RegExp(description));
  let el: HTMLElement | null = desc;
  while (el && el.tagName.toLowerCase() !== 'body') {
    const switches = el.querySelectorAll('button[role="switch"]');
    if (switches.length === 1) return switches[0] as HTMLButtonElement;
    el = el.parentElement;
  }
  throw new Error('plugin switch not found');
}

describe('Plugins page', () => {
  beforeEach(() => {
    localStorage.clear();
    syncMockReset();
  });

  it('renders the plugins header and how-it-works copy', () => {
    mount();
    expect(screen.getByText('Plugins')).toBeInTheDocument();
    expect(screen.getByText(/Two-layer activation/)).toBeInTheDocument();
  });

  it('ships every plugin disabled (DISABLED) before the operator enables anything', async () => {
    mount();
    // Wait for activation layers to load from the (mock) backend.
    await waitFor(() => expect(screen.getAllByText(/DISABLED/).length).toBe(1));
  });

  it('lets the operator enable a plugin at the instance level', async () => {
    mount();
    fireEvent.click(
      screen.getByRole('switch', { name: /Server availability: Nixre Assistant/ }),
    );
    // The PUT is fire-and-forget in the UI, so poll until it lands.
    await waitFor(async () => {
      expect(await isPluginAvailable('nixre-assistant')).toBe(true);
    });
    // The plugin card flips from DISABLED to OFF (available, not yet enabled).
    expect(await screen.findByText('OFF')).toBeInTheDocument();
  });

  it('activates a plugin once the user toggles it on', async () => {
    mount();
    fireEvent.click(
      screen.getByRole('switch', { name: /Server availability: Nixre Assistant/ }),
    );
    fireEvent.click(pluginSwitch('AI copilot for agentic engineering'));
    expect(await screen.findByText('ACTIVE')).toBeInTheDocument();
    await waitFor(async () => {
      expect(await isPluginLive('nixre-assistant')).toBe(true);
    });
  });

  it('opens the configure drawer for the assistant', async () => {
    mount();
    fireEvent.click(
      screen.getByRole('switch', { name: /Server availability: Nixre Assistant/ }),
    );
    fireEvent.click(screen.getByText('Configure'));
    // The drawer renders the provider manager.
    expect(await screen.findByText(/Add providers, fetch their models/)).toBeInTheDocument();
  });
});
