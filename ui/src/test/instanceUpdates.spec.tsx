import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InstanceUpdates, UpdateProgressPage } from '../components/InstanceUpdates';
import { App } from '../App';
import { observeUpdate } from '../lib/instanceUpdates';

const { api } = vi.hoisted(() => ({ api: {
  getInstanceUpdates: vi.fn(), checkInstanceUpdate: vi.fn(), applyInstanceUpdate: vi.fn(), currentUser: vi.fn(),
} }));
vi.mock('../lib/api', () => ({ api }));
vi.mock('../lib/instanceUpdates', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/instanceUpdates')>(), observeUpdate: vi.fn(),
}));
const plan = { id: 'review', base: 'a'.repeat(40), target: 'b'.repeat(40), available: true, createdAt: Date.now(),
  files: [{ status: 'A', path: 'backend/src/db/migrations/028_example.sql' }], totalFiles: 1,
  migrations: ['028_example.sql'], ciUrl: 'https://github.com/Akicou/Nixre/actions/runs/1' };
const current = { id: 'job', status: 'checked', actor: 'admin', startedAt: Date.now(), steps: [], plan };
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); window.history.replaceState({}, '', '/'); });
afterEach(() => { cleanup(); vi.useRealTimers(); window.history.replaceState({}, '', '/'); });

it('explains the one-time installation when the worker is unavailable', async () => {
  api.getInstanceUpdates.mockResolvedValue({ enabled: false });
  render(<InstanceUpdates />);
  expect(await screen.findByText(/One-time host setup required/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Back up and update' })).not.toBeInTheDocument();
});
it('requires review and binds the update request to the displayed revision', async () => {
  api.getInstanceUpdates.mockResolvedValue({ enabled: true, current, watchToken: 'read-only-token' });
  api.applyInstanceUpdate.mockRejectedValue(new Error('Connection lost. Reconnect to check whether it started.'));
  render(<InstanceUpdates />);
  const apply = await screen.findByRole('button', { name: 'Back up and update' });
  expect(apply).toBeDisabled();
  expect(screen.getByText('028_example.sql')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(apply);
  await waitFor(() => expect(api.applyInstanceUpdate).toHaveBeenCalledWith({ requestId: expect.any(String), planId: plan.id, target: plan.target, expectedBase: plan.base }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Reconnect/);
  expect(apply).toBeDisabled();
  expect(sessionStorage.getItem('nixre_update_observer')).toBe('read-only-token');
});
it('blocks another update while operator recovery is required', async () => {
  api.getInstanceUpdates.mockResolvedValue({ enabled: true, current: { ...current, status: 'recovery_required', database: 'committed', message: 'Migration committed; health failed.' } });
  render(<InstanceUpdates />);
  expect(await screen.findByText('Operator recovery required')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Back up and update' })).not.toBeInTheDocument();
});
it('loads the independent progress route without contacting core authentication', async () => {
  window.history.replaceState({}, '', '/update-progress');
  vi.mocked(observeUpdate).mockResolvedValue({ ...current, status: 'recovery_required', database: 'uncertain',
    message: 'Migration failed: 028_example.sql', backup: '/private/final.dump',
    steps: [{ name: 'Apply production migrations', status: 'failed' }] });
  render(<App />);
  expect(await screen.findByText('Migration failed: 028_example.sql')).toBeInTheDocument();
  expect(screen.getByText('/private/final.dump')).toBeInTheDocument();
  expect(api.currentUser).not.toHaveBeenCalled();
});
it('shows lost progress connectivity rather than inventing a successful update', async () => {
  vi.mocked(observeUpdate).mockRejectedValue(new Error('Progress connection lost. Retrying; the update may still be running.'));
  render(<UpdateProgressPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/may still be running/);
  expect(screen.queryByText('succeeded')).not.toBeInTheDocument();
});
