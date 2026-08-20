import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatSurface } from '../components/assistant/ChatSurface';
import { getActiveProviderProfile } from '../lib/assistantProfiles';

function mount() {
  return render(
    <MemoryRouter>
      <ChatSurface repoPath="acme/website" profile={getActiveProviderProfile()} title="acme/website" />
    </MemoryRouter>,
  );
}

describe('ChatSurface', () => {
  beforeEach(() => localStorage.clear());

  it('shows an empty state with suggestion chips', () => {
    mount();
    expect(screen.getByText(/How can I help in acme\/website/i)).toBeInTheDocument();
    expect(screen.getByText(/Run the tests and lint/i)).toBeInTheDocument();
  });

  it('renders the model and reasoning pickers', () => {
    mount();
    // active model label defaults to the provider's default model.
    expect(screen.getByText(getActiveProviderProfile().model)).toBeInTheDocument();
    expect(screen.getByText(/Reasoning:/i)).toBeInTheDocument();
  });

  it('streams a user turn and shows the assistant summary', async () => {
    mount();
    fireEvent.click(screen.getByText(/Run the tests and lint/i));

    // The tool block for run_tests appears, then the green summary.
    await waitFor(() => expect(screen.getByText(/run_tests/i)).toBeInTheDocument());
    expect(await screen.findByText(/suite is green/i)).toBeInTheDocument();
  });

  it('persists conversations and lists them on reload', async () => {
    mount();
    const textarea = screen.getByPlaceholderText(/Ask the assistant anything/i);
    fireEvent.change(textarea, { target: { value: 'verify persistence convo' } });
    fireEvent.click(screen.getByTitle('Send'));

    // The empty state disappears once a message is sent.
    await waitFor(() => expect(screen.queryByText(/How can I help in acme\/website/i)).not.toBeInTheDocument());
    // render() does not auto-cleanup, so unmount before re-rendering.
    cleanup();

    // A new mount should read the persisted conversation (by title) from localStorage.
    render(
      <MemoryRouter>
        <ChatSurface repoPath="acme/website" profile={getActiveProviderProfile()} title="acme/website" />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/verify persistence convo/i)).toBeInTheDocument();
  });
});
