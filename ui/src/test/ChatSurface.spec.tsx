import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatSurface } from '../components/assistant/ChatSurface';
import { getActiveProviderProfile } from '../lib/assistantProfiles';
import { installSyncFetchMock, syncMockReset, syncMockDb, lastAiJobBody } from './syncMock';

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
    cleanup();
  });

  it('shows the empty state with suggestion chips once a provider is validated', async () => {
    await mount();
    expect(screen.getByText(/How can I help in acme\/website/i)).toBeInTheDocument();
    expect(screen.getByText(/Run the tests and lint/i)).toBeInTheDocument();
  });

  it('renders the model card with effort badge', async () => {
    await mount();
    const modelBtn = await screen.findByText(/deepseek-chat/);
    fireEvent.click(modelBtn.closest('button') ?? modelBtn);
    // Reasoning effort now lives inside the Cursor-style model card footer.
    expect(await screen.findByText(/Reasoning effort/i)).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
  });

  it('streams a job turn through the server events API', async () => {
    await mount();
    fireEvent.click(screen.getByText(/Run the tests and lint/i));
    await waitFor(() =>
      expect(screen.queryByText(/How can I help in acme\/website/i)).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/suite is green/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Nothing blocking/i)).toBeInTheDocument(),
    );
  });

  it('does not stop the server job when the chat unmounts', async () => {
    const inner = globalThis.fetch;
    const stops: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.includes('/ai/jobs/') && url.includes('/stop')) stops.push(url);
      return inner(input, init);
    }) as typeof fetch;
    try {
      const view = await mount();
      fireEvent.click(screen.getByText(/Run the tests and lint/i));
      await screen.findByText(/suite is green/i);
      view.unmount();
      expect(stops).toHaveLength(0);
    } finally {
      globalThis.fetch = inner;
    }
  });

  it('auto-subscribes to a conversation that is already running on load', async () => {
    syncMockDb.conversations.push({
      id: 'conv_live',
      repoPath: 'acme/website',
      title: 'live session',
      messages: [{ id: 'u1', role: 'user', content: 'keep going', createdAt: 1 }],
      updatedAt: Date.now(),
      run_status: 'running',
      run_queue: [],
    });
    await mount();
    // Cold-load resume: a server-side turn survives browser death, so the
    // surface must reattach to it without any user interaction.
    await waitFor(() => expect(screen.getByText(/keep going/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/15 tests passing/i)).toBeInTheDocument());
    // Opened, not just listed — the transcript replaced the empty state.
    expect(screen.queryByText(/How can I help in acme\/website/i)).not.toBeInTheDocument();
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

  it('starts an environment audit job from the feedback button', async () => {
    await mount();
    fireEvent.click(screen.getByTitle('Environment feedback'));
    await waitFor(() => expect(lastAiJobBody?.kind).toBe('env_audit'));
    expect(String(lastAiJobBody?.prompt || '')).toMatch(/submit_env_feedback/);
  });
});
