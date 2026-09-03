import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../lib/deployEvents', () => ({ subscribeDeployEvents: () => () => {} }));

const { api } = vi.hoisted(() => ({
  api: {
    spaceDeployments: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({ api }));

import { SpaceDeployments } from '../components/SpaceDeployments';

const board = {
  services: [
    {
      id: 12,
      name: 'web',
      root_dir: '.',
      dockerfile_path: 'Dockerfile',
      branch: 'main',
      auto_deploy: true,
      container_port: 3000,
      cpu_nano_cpus: 1e9,
      memory_bytes: 536870912,
      desired_state: 'running' as const,
      status: 'running' as const,
      current_deployment_id: 77,
      last_failed_deployment_id: null as number | null,
      preserve_status_min: 400,
      success_retention_hours: 24,
      failure_retention_hours: 168,
      created: 1,
      updated: 1,
      repo_uid: 'webshop',
      alert: false,
      domains: ['shop.acme.dev'],
      current: {
        id: 77,
        ref: 'main',
        sha: 'deadbeef00',
        short_sha: 'deadbee',
        message: 'add feature',
        status: 'live',
        trigger: 'push',
        started: Date.now() - 3600_000,
        finished: Date.now() - 3500_000,
      },
    },
    {
      id: 13,
      name: 'api',
      root_dir: 'api',
      dockerfile_path: 'Dockerfile',
      branch: 'main',
      auto_deploy: true,
      container_port: 8080,
      cpu_nano_cpus: 1e9,
      memory_bytes: 536870912,
      desired_state: 'running' as const,
      status: 'running' as const,
      current_deployment_id: null,
      last_failed_deployment_id: 91,
      preserve_status_min: 400,
      success_retention_hours: 24,
      failure_retention_hours: 168,
      created: 2,
      updated: 2,
      repo_uid: 'api',
      alert: true,
      domains: [],
      current: null,
    },
  ],
  activity: [
    {
      id: 91,
      service_id: 13,
      service_name: 'api',
      ref: 'main',
      short_sha: 'cafe123',
      status: 'failed',
      trigger: 'push',
      started: Date.now() - 60_000,
      finished: Date.now() - 55_000,
    },
    {
      id: 77,
      service_id: 12,
      service_name: 'web',
      ref: 'main',
      short_sha: 'deadbee',
      status: 'live',
      trigger: 'push',
      started: Date.now() - 3600_000,
      finished: Date.now() - 3500_000,
    },
  ],
};

function mount() {
  return render(
    <MemoryRouter initialEntries={['/acme']}>
      <Routes>
        <Route path="/:space" element={<SpaceDeployments spaceUid="acme" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SpaceDeployments board', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.spaceDeployments.mockResolvedValue(board);
  });

  it('renders a card per service with status, domain and deploy info', async () => {
    mount();
    const card = await screen.findByTestId('board-card-web');
    expect(card.textContent).toContain('shop.acme.dev');
    expect(card.textContent).toMatch(/Deployed .* ago via git push/);
    const failed = await screen.findByTestId('board-card-api');
    expect(failed.textContent).toContain('last release failed');
  });

  it('shows the activity feed with recent deploys', async () => {
    mount();
    await screen.findByTestId('board-activity');
    expect(await screen.findByText('Deploy failed · main')).toBeInTheDocument();
    expect(await screen.findByText('Deployed · main')).toBeInTheDocument();
  });

  it('cards deep-link into the repo deployments section with the service id', async () => {
    mount();
    const card = await screen.findByTestId('board-card-web');
    expect(card.getAttribute('href')).toBe('/acme/webshop?deploys=1&svc=12');
  });

  it('shows an empty state when the space has no services', async () => {
    api.spaceDeployments.mockResolvedValue({ services: [], activity: [] });
    mount();
    expect(await screen.findByText(/No deployment services in this space yet/i)).toBeInTheDocument();
  });
});
