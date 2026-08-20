import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Plugins } from '../pages/Plugins';
import { isPluginLive, isPluginAvailable } from '../lib/pluginPreferences';

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
  beforeEach(() => localStorage.clear());

  it('renders the plugins header and how-it-works copy', () => {
    mount();
    expect(screen.getByText('Plugins')).toBeInTheDocument();
    expect(screen.getByText(/Two-layer activation/)).toBeInTheDocument();
  });

  it('ships every plugin disabled (DISABLED) before the operator enables anything', () => {
    mount();
    expect(screen.getAllByText(/DISABLED/).length).toBe(7);
  });

  it('lets the operator enable a plugin at the instance level', async () => {
    mount();
    fireEvent.click(
      screen.getByRole('switch', { name: /Server availability: CI\/CD Pipelines/ }),
    );
    expect(isPluginAvailable('ci-cd-pipelines')).toBe(true);
    // The plugin card flips from DISABLED to OFF (available, not yet enabled).
    expect(await screen.findByText('OFF')).toBeInTheDocument();
  });

  it('activates a plugin once the user toggles it on', async () => {
    mount();
    fireEvent.click(
      screen.getByRole('switch', { name: /Server availability: Issues Tracker/ }),
    );
    fireEvent.click(pluginSwitch('Create, list, assign, label and close issues'));
    expect(await screen.findByText('ACTIVE')).toBeInTheDocument();
    expect(isPluginLive('issues-tracker')).toBe(true);
  });

  it('opens the configure drawer for a form plugin', () => {
    mount();
    fireEvent.click(
      screen.getByRole('switch', { name: /Server availability: CI\/CD Pipelines/ }),
    );
    fireEvent.click(screen.getByText('Configure'));
    expect(screen.getByText('CI/CD Pipelines settings')).toBeInTheDocument();
  });
});
