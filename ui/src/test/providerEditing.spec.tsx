import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssistantProfileForm } from '../components/assistant/AssistantProfileForm';
import { listAiProviders, updateAiProvider, createAiProvider, type AiProvider } from '../lib/aiApi';

vi.mock('../lib/aiApi', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/aiApi')>(),
  listAiProviders: vi.fn(),
  updateAiProvider: vi.fn(),
  createAiProvider: vi.fn(),
}));

const provider: AiProvider = {
  id: 7, label: 'Work API', provider: 'custom', providerLabel: 'Custom',
  baseUrl: 'https://api.example.com/v1', keyConfigured: true, keyMask: 'sk-…1234',
  validatedAt: 1, defaultModel: 'model-a', models: ['model-a', 'model-b'],
  enabledModels: ['model-a'], isDefault: true, created: 1, updated: 1,
};

async function edit() {
  render(<AssistantProfileForm mode="provider" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Work API' }));
}

describe('Editing providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAiProviders).mockResolvedValue([provider]);
    vi.mocked(updateAiProvider).mockImplementation(async (_id, input) => ({ ...provider, ...input }));
  });

  it('renames the existing provider without sending a key or recreating it', async () => {
    await edit();
    expect(screen.getByLabelText('Replace API key')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed API' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateAiProvider).toHaveBeenCalledWith(7, { label: 'Renamed API' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Existing API key kept');
    expect(createAiProvider).not.toHaveBeenCalled();
  });

  it('replaces credentials and endpoint on the same provider', async () => {
    await edit();
    fireEvent.change(screen.getByLabelText('Replace API key'), { target: { value: 'new-test-key' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://new.example.com/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(updateAiProvider).toHaveBeenCalledWith(7, {
      label: 'Work API', apiKey: 'new-test-key', baseUrl: 'https://new.example.com/v1',
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('New API key validated');
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });

  it('keeps the draft after validation failure and lets the user retry', async () => {
    vi.mocked(updateAiProvider).mockRejectedValueOnce(new Error('Validation failed: invalid key'));
    await edit();
    fireEvent.change(screen.getByLabelText('Replace API key'), { target: { value: 'bad-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid key');
    expect(screen.getByLabelText('Replace API key')).toHaveValue('bad-test-key');
    fireEvent.change(screen.getByLabelText('Replace API key'), { target: { value: 'good-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('status')).toHaveTextContent('updated');
  });

  it('discards a replacement key on cancel', async () => {
    await edit();
    fireEvent.change(screen.getByLabelText('Replace API key'), { target: { value: 'discard-me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Work API' }));
    expect(screen.getByLabelText('Replace API key')).toHaveValue('');
    expect(updateAiProvider).not.toHaveBeenCalled();
  });
});
