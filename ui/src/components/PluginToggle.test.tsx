import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PluginToggle, type PluginToggleProps } from '../components/PluginToggle';
import { getPlugin } from '../lib/plugins';

function mount(
  id: string,
  props: Partial<PluginToggleProps> = {},
) {
  return render(<PluginToggle plugin={getPlugin(id)!} available={true} enabled={false} onToggle={vi.fn()} onConfigure={vi.fn()} {...props} />);
}

describe('PluginToggle', () => {
  it('renders the plugin name and description', () => {
    mount('nixre-assistant');
    expect(screen.getByText('Nixre Assistant')).toBeInTheDocument();
    expect(screen.getByText(/AI copilot for agentic engineering/i)).toBeInTheDocument();
  });

  it('shows the tool chips for the assistant', () => {
    mount('nixre-assistant');
    expect(screen.getByText('list_files')).toBeInTheDocument();
    expect(screen.getByText('web_search')).toBeInTheDocument();
  });

  it('calls onToggle(true) when the switch is clicked', () => {
    const onToggle = vi.fn();
    mount('nixre-assistant', { available: true, enabled: false, onToggle });
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('shows Configure for the assistant when available', () => {
    const onConfigure = vi.fn();
    mount('nixre-assistant', { available: true, enabled: true, onConfigure });
    fireEvent.click(screen.getByText('Configure'));
    expect(onConfigure).toHaveBeenCalled();
  });

  it('marks an active plugin as ACTIVE', () => {
    mount('nixre-assistant', { available: true, enabled: true });
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });

  it('disables the switch and hides Configure when the server gate is off', () => {
    const onToggle = vi.fn();
    mount('nixre-assistant', { available: false, enabled: false, onToggle });
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText(/DISABLED/)).toBeInTheDocument();
    expect(screen.queryByText('Configure')).toBeNull();
  });
});
