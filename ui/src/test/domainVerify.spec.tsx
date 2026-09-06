// Custom-domain ownership gate (UI side).
//
// Attaching a hostname is not proof you control it, so a newly attached domain
// is parked: the proxy will not route it. The UI must say so plainly and offer
// the TXT challenge — otherwise a user attaches a domain, sees no error, and
// silently gets no traffic.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, type DeployService } from '../lib/api';
import { DomainsPanel } from '../pages/DeploymentsPage';

vi.mock('../lib/api', () => ({
  api: {
    listDomains: vi.fn(),
    verifyDomain: vi.fn(),
    addDomain: vi.fn(),
    removeDomain: vi.fn(),
    retryDomainDns: vi.fn(),
  },
}));

const SERVICE: DeployService = {
  id: 12,
  name: 'webshop',
  root_dir: '.',
  dockerfile_path: 'Dockerfile',
  branch: 'main',
  auto_deploy: true,
  container_port: 8080,
  cpu_nano_cpus: 1_000_000_000,
  memory_bytes: 536_870_912,
  desired_state: 'running',
  status: 'running',
  current_deployment_id: null,
  last_failed_deployment_id: null,
  preserve_status_min: 400,
  success_retention_hours: 24,
  failure_retention_hours: 168,
  created: 1,
  updated: 1,
};

function unverifiedDomain(overrides = {}) {
  return {
    id: 7,
    kind: 'tunnel' as const,
    domain: 'shop.example.com',
    created: 1,
    tls_risk: false,
    verified: false,
    verification: {
      verified: false,
      method: 'txt' as const,
      note: 'Publish this DNS record, then choose Verify ownership.',
      record: {
        type: 'TXT' as const,
        name: '_nixre-verify.shop.example.com',
        value: 'nixre-verify=abc123',
      },
    },
    dns: { auto: false, status: 'manual' as const },
    guidance: { dns: [], notes: [] },
    ...overrides,
  };
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/acme/webshop?deploys=1']}>
      <Routes>
        <Route path="/:space/:repo" element={<DomainsPanel service={SERVICE} />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listDomains).mockResolvedValue([unverifiedDomain()]);
  vi.mocked(api.verifyDomain).mockResolvedValue({
    id: 7,
    domain: 'shop.example.com',
    verified: true,
  });
});

describe('domain ownership gate', () => {
  it('shows an unverified badge and the TXT challenge', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('domain-unverified-badge')).toBeTruthy());

    expect(screen.getByTestId('domain-verify-panel')).toBeTruthy();
    expect(screen.getByText(/_nixre-verify\.shop\.example\.com/)).toBeTruthy();
    expect(screen.getByText(/nixre-verify=abc123/)).toBeTruthy();
    // States clearly that the hostname is not being served yet.
    expect(screen.getByText(/Not verified — not routed/)).toBeTruthy();
  });

  it('calls verifyDomain when the user proves ownership', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('domain-verify')).toBeTruthy());

    fireEvent.click(screen.getByTestId('domain-verify'));

    await waitFor(() =>
      expect(api.verifyDomain).toHaveBeenCalledWith('acme', 'webshop', 12, 7, false),
    );
  });

  it('surfaces the server message when verification fails', async () => {
    vi.mocked(api.verifyDomain).mockRejectedValue(
      new Error('No TXT record found at _nixre-verify.shop.example.com'),
    );
    mount();
    await waitFor(() => expect(screen.getByTestId('domain-verify')).toBeTruthy());

    fireEvent.click(screen.getByTestId('domain-verify'));

    await waitFor(() => expect(screen.getByText(/No TXT record found/)).toBeTruthy());
  });

  it('shows a verified badge and no challenge for a proven domain', async () => {
    vi.mocked(api.listDomains).mockResolvedValue([
      unverifiedDomain({ verified: true, verification: { verified: true } }),
    ]);
    mount();
    await waitFor(() => expect(screen.getByTestId('domain-verified-badge')).toBeTruthy());
    expect(screen.queryByTestId('domain-unverified-badge')).toBeNull();
    expect(screen.queryByTestId('domain-verify-panel')).toBeNull();
  });
});
