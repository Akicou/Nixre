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
    mount('ci-cd-pipelines');
    expect(screen.getByText('CI/CD Pipelines')).toBeInTheDocument();
    expect(screen.getByText(/surface Gitness CI runs/i)).toBeInTheDocument();
  });

  it('shows the tool chips for the assistant', () => {
    mount('nixre-assistant');
    expect(screen.getByText('file_read')).toBeInTheDocument();
    expect(screen.getByText('git')).toBeInTheDocument();
  });

  it('calls onToggle(true) when the switch is clicked', () => {
    const onToggle = vi.fn();
    mount('ci-cd-pipelines', { available: true, enabled: false, onToggle });
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('shows Configure for form plugins when available', () => {
    const onConfigure = vi.fn();
    mount('ci-cd-pipelines', { available: true, enabled: true, onConfigure });
    fireEvent.click(screen.getByText('Configure'));
    expect(onConfigure).toHaveBeenCalled();
  });

  it('marks an active plugin as ACTIVE', () => {
    mount('ci-cd-pipelines', { available: true, enabled: true });
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
  });

  it('disables the switch and hides Configure when the server gate is off', () => {
    const onToggle = vi.fn();
    mount('ci-cd-pipelines', { available: false, enabled: false, onToggle });
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText(/DISABLED/)).toBeInTheDocument();
    expect(screen.queryByText('Configure')).toBeNull();
  });
});
