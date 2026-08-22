import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatSurface } from '../components/assistant/ChatSurface';
import { getActiveProviderProfile } from '../lib/assistantProfiles';
import { installSyncFetchMock, syncMockReset } from './syncMock';

installSyncFetchMock();

async function mount() {
  const profile = await getActiveProviderProfile();
  return render(
    <MemoryRouter>
      <ChatSurface repoPath="acme/website" profile={profile} title="acme/website" />
    </MemoryRouter>,
  );
}

describe('ChatSurface', () => {
  beforeEach(() => {
    localStorage.clear();
    syncMockReset();
  });

  it('shows the empty state with suggestion chips once a provider is validated', async () => {
    await mount();
    expect(screen.getByText(/How can I help in acme\/website/i)).toBeInTheDocument();
    expect(screen.getByText(/Run the tests and lint/i)).toBeInTheDocument();
  });

  it('renders the model and reasoning pickers', async () => {
    await mount();
    expect(await screen.findByText(/deepseek-chat/)).toBeInTheDocument();
    expect(screen.getByText(/Reasoning:/i)).toBeInTheDocument();
  });

  it('streams a real turn through the provider proxy', async () => {
    await mount();
    fireEvent.click(screen.getByText(/Run the tests and lint/i));

    // The mock /ai/chat stream answers with the green-suite summary.
    expect(await screen.findByText(/suite is green/i)).toBeInTheDocument();
    // Reasoning was streamed (interleaved flag off drops it — text only).
    await waitFor(() =>
      expect(screen.getByText(/Nothing blocking/i)).toBeInTheDocument(),
    );
  });

  it('persists conversations and lists them on reload', async () => {
    await mount();
    const textarea = screen.getByPlaceholderText(/Ask the assistant anything/i);
    fireEvent.change(textarea, { target: { value: 'verify persistence convo' } });
    fireEvent.click(screen.getByTitle('Send'));

    // The empty state disappears once a message is sent.
    await waitFor(() => expect(screen.queryByText(/How can I help in acme\/website/i)).not.toBeInTheDocument());
    // render() does not auto-cleanup, so unmount before re-rendering.
    cleanup();

    // A new mount should read the persisted conversation (by title) from the backend.
    await mount();
    expect(await screen.findByText(/verify persistence convo/i)).toBeInTheDocument();
  });
});
