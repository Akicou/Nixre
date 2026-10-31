import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SecurityScanSettings } from '../components/SecurityScanSettings';

const { api } = vi.hoisted(() => ({
  api: {
    getSecurityScan: vi.fn(),
    saveSecurityScan: vi.fn(),
    runSecurityScan: vi.fn(),
    getSecurityScanRun: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({ api }));

const settings = { enabled: false, intervalHours: 3, providerId: null, model: '', coreRepo: '' };
const providers = [{ id: 7, label: 'Main', provider: 'openai', models: ['gpt-x', 'gpt-y'], defaultModel: 'gpt-x' }];
const run = {
  id: 1, started: 1, finished: 2, status: 'ok', trigger: 'manual', summary: '2 findings',
  error: null, findings: 2, issues_created: 1, report: null,
};

describe('SecurityScanSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getSecurityScan.mockResolvedValue({ settings, providers, running: false, runs: [run] });
  });

  it('saves the chosen provider, model and interval', async () => {
    api.saveSecurityScan.mockResolvedValue({ settings: { ...settings, enabled: true }, providers, running: false, runs: [run] });
    render(<SecurityScanSettings />);
    await screen.findByText('Enable scheduled scans');
    fireEvent.click(screen.getByLabelText('Enable scheduled scans'));
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.saveSecurityScan).toHaveBeenCalledWith({
        enabled: true, intervalHours: 3, providerId: 7, model: 'gpt-x', coreRepo: '',
      }),
    );
  });

  it('starts a run and expands a run report', async () => {
    api.runSecurityScan.mockResolvedValue({ started: true });
    api.getSecurityScanRun.mockResolvedValue({ ...run, report: { markdown: 'All **clear**' } });
    render(<SecurityScanSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(api.runSecurityScan).toHaveBeenCalled());

    fireEvent.click(await screen.findByText('2 findings'));
    expect(await screen.findByText('clear')).toBeInTheDocument();
  });
});
