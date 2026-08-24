import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ComposerMic } from '../components/assistant/ComposerMic';

const { api } = vi.hoisted(() => ({
  api: {
    getStt: vi.fn(),
    transcribeAudio: vi.fn(),
  },
}));

vi.mock('../lib/api', () => ({ api }));

describe('ComposerMic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables the mic and shows a warning tooltip when STT is not configured', async () => {
    api.getStt.mockResolvedValue({ configured: false, base_url: null, model: null });
    render(<ComposerMic onTranscript={() => {}} />);

    const btn = await screen.findByRole('button', { name: 'Speak' });
    expect(btn).toBeDisabled();
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Speech is not configured/);
    expect(screen.getByRole('link', { name: /Settings → Speech/ })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: /STT docs/ })).toHaveAttribute(
      'href',
      'https://openrouter.ai/docs/guides/overview/multimodal/stt',
    );
  });

  it('enables the mic when an endpoint is configured', async () => {
    api.getStt.mockResolvedValue({
      configured: true,
      base_url: 'https://openrouter.ai/api/v1',
      model: 'openai/whisper-large-v3',
      key_mask: '…abcd',
    });
    render(<ComposerMic onTranscript={() => {}} />);

    const btn = await screen.findByRole('button', { name: 'Speak' });
    await waitFor(() => expect(btn).not.toBeDisabled());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
