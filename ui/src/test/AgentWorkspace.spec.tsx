import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentWorkspace } from '../pages/AgentWorkspace';
import { installSyncFetchMock, syncMockReset, lastAiJobBody } from './syncMock';

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
});
