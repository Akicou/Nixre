import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/aiApi', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/aiApi')>();
  return {
    ...actual,
    listAiProviders: vi.fn(),
    createAiProvider: vi.fn(),
    updateAiProvider: vi.fn(),
    deleteAiProvider: vi.fn(),
    fetchProviderModels: vi.fn(),
  };
});

import { listAiProviders } from '../lib/aiApi';
import { AssistantProfileForm } from '../components/assistant/AssistantProfileForm';

const provider = {
  id: 1,
  label: 'DeepSeek',
  provider: 'deepseek',
  providerLabel: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  keyConfigured: true,
  keyMask: 'sk-…abc',
  validatedAt: Date.now(),
  defaultModel: 'deepseek-chat',
  models: ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o', 'gpt-4o-mini'],
  enabledModels: ['deepseek-chat', 'gpt-4o'],
  isDefault: true,
  created: Date.now(),
  updated: Date.now(),
};

beforeEach(() => {
  vi.mocked(listAiProviders).mockResolvedValue([provider]);
});

describe('AssistantProfileForm model list', () => {
  it('renders a search box and filter and filters models by typing', async () => {
    render(<AssistantProfileForm mode="provider" />);

    // Models render
    expect(await screen.findByText('deepseek-chat')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();

    // Type into the search box → only matching models remain
    fireEvent.change(screen.getByPlaceholderText('Search models…'), { target: { value: 'gpt' } });
    await waitFor(() => {
      expect(screen.getByText('gpt-4o')).toBeInTheDocument();
      expect(screen.queryByText('deepseek-chat')).not.toBeInTheDocument();
      expect(screen.queryByText('deepseek-reasoner')).not.toBeInTheDocument();
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    });
  });

  it('shows only enabled models when the enabled filter is clicked', async () => {
    render(<AssistantProfileForm mode="provider" />);
    await screen.findByText('deepseek-chat');

    fireEvent.click(screen.getByRole('button', { name: 'enabled' }));
    await waitFor(() => {
      expect(screen.getByText('deepseek-chat')).toBeInTheDocument();
      expect(screen.getByText('gpt-4o')).toBeInTheDocument();
      expect(screen.queryByText('deepseek-reasoner')).not.toBeInTheDocument();
      expect(screen.queryByText('gpt-4o-mini')).not.toBeInTheDocument();
    });
  });

  it('shows only disabled models when the disabled filter is clicked', async () => {
    render(<AssistantProfileForm mode="provider" />);
    await screen.findByText('deepseek-chat');

    fireEvent.click(screen.getByRole('button', { name: 'disabled' }));
    await waitFor(() => {
      expect(screen.queryByText('deepseek-chat')).not.toBeInTheDocument();
      expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument();
      expect(screen.getByText('deepseek-reasoner')).toBeInTheDocument();
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    });
  });

  it('shows the enable/disable count in the header', async () => {
    render(<AssistantProfileForm mode="provider" />);
    await screen.findByText('deepseek-chat');
    expect(screen.getByText('2/4 enabled')).toBeInTheDocument();
  });
});
