import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentWorkspace } from '../pages/AgentWorkspace';
import { installSyncFetchMock, syncMockReset, syncMockDb, lastAiJobBody } from './syncMock';

installSyncFetchMock();

vi.mock('../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listRepos: vi.fn().mockResolvedValue([
        {
          id: 1,
          uid: 'acme/website',
          path: 'acme/website',
          description: 'w',
          is_public: true,
          default_branch: 'main',
          git_url: '',
          git_ssh_url: '',
          size: 0,
          num_forks: 0,
        },
      ]),
      getStt: vi.fn().mockResolvedValue({ configured: false, base_url: null, model: null }),
      listGithubRepos: vi.fn().mockResolvedValue({
        configured: true,
        valid: true,
        repos: [
          { full_name: 'octo/widget', private: false, description: '', updated_at: '' },
          { full_name: 'octo/private-repo', private: true, description: '', updated_at: '' },
        ],
      }),
    },
  };
});

vi.mock('../lib/pluginPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/pluginPreferences')>();
  return {
    ...actual,
    isPluginLive: vi.fn().mockResolvedValue(true),
  };
});

vi.mock('../lib/assistantProfiles', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/assistantProfiles')>();
  return {
    ...actual,
    getActiveProviderProfile: vi.fn().mockResolvedValue({
      provider: 'deepseek',
      baseUrl: '',
      model: 'deepseek-chat',
      reasoningLevel: 'medium',
      interleavedReasoning: true,
      keyConfigured: true,
      keyMask: '…abcd',
      validatedAt: Date.now(),
      models: ['deepseek-chat', 'deepseek-reasoner'],
    }),
    isRealAi: () => true,
  };
});

describe('AgentWorkspace', () => {
  beforeEach(() => {
    localStorage.clear();
    syncMockReset();
  });

  it('renders the Cursor-style empty canvas with floating composer', async () => {
    render(
      <MemoryRouter initialEntries={['/agent']}>
        <AgentWorkspace />
      </MemoryRouter>,
    );

    // New Agent rail entry
    expect(await screen.findByText('New Agent')).toBeInTheDocument();

    // Floating composer placeholder (Cursor-style)
    expect(
      await screen.findByPlaceholderText(/Plan, Build, \/ for tools, @ for context/i),
    ).toBeInTheDocument();

    // Quick chips under the composer
    expect(screen.getByText('Plan a feature')).toBeInTheDocument();
    expect(screen.getByText('Fix failing tests')).toBeInTheDocument();

    // Repo context strip
    await waitFor(() => {
      expect(screen.getByText('acme/website')).toBeInTheDocument();
    });
  });

  it('keeps attachment selection separate from the model picker and sends selected files', async () => {
    render(<MemoryRouter><AgentWorkspace /></MemoryRouter>);
    const model = await screen.findByRole('button', { name: /Select model:/ });
    fireEvent.click(model);
    expect(screen.getByText('Reasoning effort')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    expect(screen.queryByText('Reasoning effort')).not.toBeInTheDocument();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [file] } });
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    fireEvent.click(model);
    fireEvent.click(screen.getByRole('button', { name: /deepseek-reasoner/ }));
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Send'));
    await waitFor(() => expect(lastAiJobBody?.images).toEqual([
      expect.objectContaining({ name: 'notes.txt', kind: 'file', dataUrl: expect.stringContaining('data:text/plain;base64,') }),
    ]));
  });

  it('reports attachment limits and lets users remove and reselect files', async () => {
    render(<MemoryRouter><AgentWorkspace /></MemoryRouter>);
    await screen.findByRole('button', { name: 'Attach' });
    const picker = screen.getByLabelText('Attach files');
    const files = Array.from({ length: 5 }, (_, i) => new File(['hi'], `file-${i}.txt`, { type: 'text/plain' }));
    fireEvent.change(picker, { target: { files } });
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 4 attachments');
    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment file-0.txt' }));
    expect(screen.queryByText('file-0.txt')).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { files: [files[0]] } });
    expect(await screen.findByText('file-0.txt')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows file-size errors without discarding the draft', async () => {
    render(<MemoryRouter><AgentWorkspace /></MemoryRouter>);
    const input = await screen.findByPlaceholderText(/Plan, Build/);
    fireEvent.change(input, { target: { value: 'Keep my draft' } });
    const oversized = new File(['x'], 'large.png', { type: 'image/png' });
    Object.defineProperty(oversized, 'size', { value: 5 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText('Attach files'), { target: { files: [oversized] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('File too large');
    expect(input).toHaveValue('Keep my draft');
    expect(screen.queryByText('large.png')).not.toBeInTheDocument();
  });

  it('auto-reattaches to a running session on load', async () => {
    syncMockDb.conversations.push({
      id: 'conv_run',
      repoPath: 'acme/website',
      title: 'running task',
      messages: [{ id: 'u1', role: 'user', content: 'carry on', createdAt: 1 }],
      updatedAt: Date.now(),
      run_status: 'running',
      run_queue: [],
    });
    render(
      <MemoryRouter initialEntries={['/agent']}>
        <AgentWorkspace />
      </MemoryRouter>,
    );

    // Cold-load resume: the running session is opened and followed with no
    // user interaction — the transcript replaces the empty hero.
    await waitFor(() => expect(screen.getByText(/carry on/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/15 tests passing/i)).toBeInTheDocument());
    expect(screen.queryByText('Plan a feature')).not.toBeInTheDocument();
  });

  it('does not stop the server job when the workspace unmounts', async () => {
    const inner = globalThis.fetch;
    const stops: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.includes('/ai/jobs/') && url.includes('/stop')) stops.push(url);
      return inner(input, init);
    }) as typeof fetch;
    try {
      const view = render(
        <MemoryRouter initialEntries={['/agent']}>
          <AgentWorkspace />
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByText('Plan a feature'));
      await screen.findByText(/suite is green/i);
      view.unmount();
      expect(stops).toHaveLength(0);
    } finally {
      globalThis.fetch = inner;
    }
  });

  it('starts an environment audit job from the feedback button', async () => {
    render(
      <MemoryRouter initialEntries={['/agent']}>
        <AgentWorkspace />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTitle('Environment feedback'));
    await waitFor(() => expect(lastAiJobBody?.kind).toBe('env_audit'));
  });

  it('repo picker searches sources and switches to GitHub/Unrestricted targets', async () => {
    render(
      <MemoryRouter initialEntries={['/agent']}>
        <AgentWorkspace />
      </MemoryRouter>,
    );

    // Open the picker: Unrestricted is pinned, the Nixre section lists hosted repos.
    fireEvent.click(await screen.findByText('acme/website'));
    const input = await screen.findByPlaceholderText(/search repositories/i);
    expect(screen.getByText('free-form')).toBeInTheDocument();
    expect(await screen.findByText('octo/widget')).toBeInTheDocument();
    expect(screen.getByText('octo/private-repo')).toBeInTheDocument();

    // Search narrows both sources.
    fireEvent.change(input, { target: { value: 'widget' } });
    expect(screen.queryByText('octo/private-repo')).not.toBeInTheDocument();

    // Selecting a GitHub repo retargets the workspace.
    fireEvent.click(screen.getByText('octo/widget'));
    expect(await screen.findByText('octo/widget')).toBeInTheDocument();

    // Switch to Unrestricted mode.
    fireEvent.click(screen.getByText('octo/widget'));
    fireEvent.click(await screen.findByText('free-form'));
    expect(await screen.findByText('Unrestricted')).toBeInTheDocument();
  });
});
