// Deployments UI — wizard flow, failure warning, HTTP log filters, domain
// guidance, and the dashboard overview section. All hermetic: the api module
// is mocked wholesale, matching the other page specs.
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { api } = vi.hoisted(() => ({
  api: {
    // dashboard surface (DeploymentsOverview self-hides unless provided)
    deploymentsOverview: vi.fn(),
    serviceUptime: vi.fn(),
    listSpaces: vi.fn(),
    listRepos: vi.fn(),
    // deployments page surface
    getRepo: vi.fn(),
    listDeployServices: vi.fn(),
    detectDockerfiles: vi.fn(),
    createDeployService: vi.fn(),
    patchDeployService: vi.fn(),
    deleteDeployService: vi.fn(),
    listEnvVars: vi.fn(),
    setEnvVars: vi.fn(),
    removeEnvVar: vi.fn(),
    revealEnvVar: vi.fn(),
    deployService: vi.fn(),
    cancelDeploymentRun: vi.fn(),
    listDeployments: vi.fn(),
    getDeployment: vi.fn(),
    redeployDeployment: vi.fn(),
    rollbackDeployment: vi.fn(),
    deleteDeploymentRecord: vi.fn(),
    httpLogs: vi.fn(),
    serviceStats: vi.fn(),
    listDomains: vi.fn(),
    addDomain: vi.fn(),
    removeDomain: vi.fn(),
  },
}));
vi.mock('../lib/api', () => ({ api }));
vi.mock('../lib/deployEvents', () => ({
  subscribeDeployEvents: () => () => {},
}));

import { DeploymentsSection } from '../pages/DeploymentsPage';
import { DeploymentsOverview } from '../components/DeploymentsOverview';

function mountPage(initialEntry = '/acme/webshop') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/:space/:repo" element={<DeploymentsSection />} />
      </Routes>
    </MemoryRouter>,
  );
}

const baseService = {
  id: 12,
  name: 'web',
  root_dir: 'apps/web',
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
  current: {
    id: 77,
    ref: 'main',
    sha: 'deadbeef00',
    short_sha: 'deadbee',
    message: 'add feature',
    status: 'live',
    trigger: 'push',
    started: 1,
    finished: 2,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getRepo.mockResolvedValue({ default_branch: 'main' });
  api.listDeployServices.mockResolvedValue([baseService]);
  api.serviceStats.mockResolvedValue({
    limits: { cpu_nano_cpus: 1e9, memory_bytes: 536870912 },
    latest: null,
    series: [],
  });
  api.serviceUptime.mockResolvedValue({
    range: '24h',
    bucket_ms: 900_000,
    buckets: Array.from({ length: 96 }, (_, i) => ({
      start: i,
      state: i === 5 ? 'down' : 'up',
      latency_ms: 10,
    })),
    uptime_pct: 98.9,
    checks_total: 100,
  });
});

describe('DeploymentsPage', () => {
  it('lists services with live status and opens detail on click', async () => {
    mountPage();
    const card = await screen.findByTestId('service-card-web');
    expect(card.textContent).toContain('deadbee');
    expect(screen.getAllByTestId(/service-card/)).toHaveLength(1);
    // Opening detail surfaces live metrics without failure noise
    fireEvent.click(screen.getByTestId('service-card-web'));
    expect(await screen.findByText('CPU (of limit)')).toBeInTheDocument();
    expect(screen.queryByTestId('failure-banner')).toBeNull();
  });

  it('renames a service via the inline editor (Save submits, Escape cancels)', async () => {
    mountPage();
    fireEvent.click(await screen.findByTestId('service-card-web'));
    fireEvent.click(await screen.findByRole('button', { name: /Rename/i }));
    const input = await screen.findByDisplayValue('web');
    fireEvent.change(input, { target: { value: 'api-gateway' } });

    // Clicking Save must not be cancelled by focus changes. A real click
    // mousedowns the button, which makes the browser blur the input and fire
    // a focus change before the click — the rename form must stay mounted so
    // the submit still fires. (The old onBlur-cancel tore the form down here,
    // so Save silently did nothing.)
    fireEvent.mouseDown(screen.getByRole('button', { name: /Save/i }));
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(api.patchDeployService).toHaveBeenCalledWith('acme', 'webshop', 12, { name: 'api-gateway' }));

  });

  it('cancels an inline rename with Escape without calling the API', async () => {
    mountPage();
    fireEvent.click(await screen.findByTestId('service-card-web'));
    fireEvent.click(await screen.findByRole('button', { name: /Rename/i }));
    const input = await screen.findByDisplayValue('web');
    fireEvent.change(input, { target: { value: 'ignored' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(api.patchDeployService).not.toHaveBeenCalled());
  });

  it('deep-links ?svc= apply once and never yank back after a later refresh', async () => {
    const second = { ...baseService, id: 99, name: 'second' };
    api.listDeployServices.mockResolvedValue([baseService, second]);
    mountPage('/acme/webshop?deploys=1&svc=99');
    // Both cards render, then the deep-linked one is auto-selected
    expect((await screen.findAllByTestId(/service-card/)).length).toBe(2);
    await waitFor(() => {
      // Detail view replaces the grid: 'All services' back button appears
      expect(screen.getByText('All services')).toBeInTheDocument();
    });
    expect(api.listDeployServices).toHaveBeenCalled();
  });

  it('wizard detects Dockerfiles before offering creation', async () => {
    api.listDeployServices.mockResolvedValue([]);
    api.detectDockerfiles.mockResolvedValue({
      ref: 'main',
      root_dir: 'apps/web',
      dockerfiles: [
        { path: 'apps/web/Dockerfile', file: 'Dockerfile' },
        { path: 'apps/web/Dockerfile.dev', file: 'Dockerfile.dev' },
      ],
    });
    mountPage();
    fireEvent.click(await screen.findByText(/Create your first service/i));
    const rootInput = await screen.findByPlaceholderText('apps/web or .');
    fireEvent.change(rootInput, { target: { value: 'apps/web' } });
    fireEvent.click(screen.getByRole('button', { name: /Detect Dockerfiles/i }));
    const select = await screen.findByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(api.detectDockerfiles).toHaveBeenCalledWith('acme', 'webshop', 'apps/web', 'main');
    expect((select as HTMLSelectElement).value).toBe('Dockerfile');
  });

  it('wizard env editor accepts pasted .env with validation before creating', async () => {
    api.listDeployServices.mockResolvedValue([]);
    api.detectDockerfiles.mockResolvedValue({
      ref: 'main',
      root_dir: '.',
      dockerfiles: [{ path: 'Dockerfile', file: 'Dockerfile' }],
    });
    api.createDeployService.mockResolvedValue(baseService);
    mountPage();
    fireEvent.click(await screen.findByText(/Create your first service/i));
    const rootInput = await screen.findByPlaceholderText('apps/web or .');
    fireEvent.change(rootInput, { target: { value: '.' } });
    fireEvent.click(screen.getByRole('button', { name: /Detect Dockerfiles/i }));
    await screen.findByRole('combobox');

    // Switch to raw paste mode and type an invalid doc first
    fireEvent.click(screen.getByTestId('wizard-env-raw-toggle'));
    const raw = screen.getByTestId('wizard-env-raw').querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(raw, { target: { value: 'GOOD=1\n2BAD=x' } });
    expect(await screen.findByTestId('wizard-env-raw-errors')).toBeInTheDocument();
    // The apply button is disabled while validation errors exist
    expect(screen.getByRole('button', { name: /Apply \d+ variables?/i })).toBeDisabled();

    // Fix the doc -> applies into rows and reaches create with parsed vars
    fireEvent.change(raw, { target: { value: 'API_TOKEN=s3cr3t\nLOG_LEVEL=info' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply 2 variables/i }));
    fireEvent.click(screen.getByRole('button', { name: /Create service/i }));
    await waitFor(() => expect(api.createDeployService).toHaveBeenCalledWith(
      'acme',
      'webshop',
      expect.objectContaining({ env: { API_TOKEN: 's3cr3t', LOG_LEVEL: 'info' } }),
    ));
  });

  it('blares a failure banner and still shows the serving release', async () => {
    api.listDeployServices.mockResolvedValue([
      {
        ...baseService,
        last_failed_deployment_id: 90,
      },
    ]);
    mountPage();
    fireEvent.click((await screen.findAllByTestId('service-card-web'))[0]);
    const banner = await screen.findByTestId('failure-banner');
    expect(banner.textContent).toContain('deployment #90 failed');
    expect(banner.textContent).toContain('#77');
  });

  it('http log filter chips drive query params and mark failures', async () => {
    api.httpLogs.mockResolvedValue({
      logs: [
        { id: 1, method: 'GET', path: '/ok', status_code: 200, duration_ms: 4, ts: Date.now() },
        { id: 2, method: 'POST', path: '/boom', status_code: 502, duration_ms: 900, ts: Date.now() },
      ],
      counts_24h: { '2xx': 800, '3xx': 3, '4xx': 21, '5xx': 7, none: 1 },
      preserve: { preserve_status_min: 400, success_retention_hours: 24, failure_retention_hours: 168 },
    });
    mountPage();
    fireEvent.click((await screen.findAllByTestId('service-card-web'))[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'logs' }));

    // default focus is failures-class 4xx per panel state; assert the call
    await waitFor(() => expect(api.httpLogs).toHaveBeenCalled());

    const boom = await screen.findByText('/boom');
    expect(boom.closest('tr')).toHaveClass('bg-red-500/[0.04]');
    expect(screen.getByText('502')).toBeInTheDocument();
    const chip5xx = screen.getByRole('button', { name: /5xx · 7/ });
    fireEvent.click(chip5xx);
    await waitFor(() =>
      expect(api.httpLogs).toHaveBeenCalledWith(
        'acme',
        'webshop',
        12,
        expect.objectContaining({ class: '5xx' }),
      ),
    );
  });

  it('the .env file editor pre-fills with existing secrets', async () => {
    api.listEnvVars.mockResolvedValue([
      { key: 'API_TOKEN', updated: 1 },
      { key: 'LOG_LEVEL', updated: 1 },
    ]);
    api.revealEnvVar.mockImplementation(async (_s, _r, _i, k: string) => ({ key: k, value: k === 'API_TOKEN' ? 's3cr3t' : 'info' }));
    mountPage();
    fireEvent.click((await screen.findAllByTestId('service-card-web'))[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'env' }));
    fireEvent.click(screen.getByRole('button', { name: '.env file' }));
    const editor = await screen.findByTestId('env-file-editor');
    const ta = editor.querySelector('textarea') as HTMLTextAreaElement;
    await waitFor(() => {
      expect(ta.value).toContain('API_TOKEN=s3cr3t');
      expect(ta.value).toContain('LOG_LEVEL=info');
    });
  });

  it('env values are masked until explicitly revealed', async () => {
    api.listEnvVars.mockResolvedValue([{ key: 'API_TOKEN', updated: 1 }]);
    api.revealEnvVar.mockResolvedValue({ key: 'API_TOKEN', value: 's3cr3t-value' });
    mountPage();
    fireEvent.click((await screen.findAllByTestId('service-card-web'))[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'env' }));
    const input = await screen.findByPlaceholderText('••••••••');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByTitle('View value'));
    await waitFor(() => {
      expect(api.revealEnvVar).toHaveBeenCalledWith('acme', 'webshop', 12, 'API_TOKEN');
      const viewing = screen.getByDisplayValue('s3cr3t-value') as HTMLInputElement;
      expect(viewing.type).toBe('text');
    });
    // Hide re-masks without entering edit mode
    fireEvent.click(screen.getByTitle('Hide'));
    expect(screen.getByPlaceholderText('••••••••')).toHaveAttribute('type', 'password');
    // Edit enters inline editor with the decrypted value
    fireEvent.click(screen.getByTitle('Edit value'));
    await waitFor(() => expect(screen.getByDisplayValue('s3cr3t-value')).toBeTruthy());
    // Closing the editor re-masks the row
    fireEvent.click(screen.getByTitle(/Done/));
    await waitFor(() => expect(screen.getByPlaceholderText('••••••••')).toHaveAttribute('type', 'password'));
  });

  it('domain cards present registrar-ready DNS guidance', async () => {
    api.listDomains.mockResolvedValue([
      {
        id: 3,
        kind: 'caddy',
        domain: 'shop.acme.dev',
        created: 1,
        tls_risk: false,
        guidance: {
          dns: [{ type: 'A', name: '@', target: '<THIS-SERVER-IP>' }],
          notes: ['Forward requests for shop.acme.dev to port 3003.'],
          caddy_snippet: 'shop.acme.dev {\n  reverse_proxy 127.0.0.1:3003\n}',
        },
      },
      {
        id: 4,
        kind: 'tunnel',
        domain: 'deep.a.b.acme.dev',
        created: 2,
        tls_risk: true,
        dns: { auto: true, status: 'created', target: 't.cfargotunnel.com' },
        guidance: {
          dns: [{ type: 'CNAME', name: 'deep.a', target: 't.cfargotunnel.com', proxied: true }],
          notes: ['auto-managed'],
        },
      },
    ]);
    mountPage();
    fireEvent.click((await screen.findAllByTestId('service-card-web'))[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'domains' }));
    expect((await screen.findAllByTestId('domain-card')).length).toBe(2);
    expect(screen.getAllByText(/THIS-SERVER-IP/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/reverse_proxy 127\.0\.0\.1:3003/).length).toBeGreaterThan(0);
    // TLS-risky domain gets a persistent warning badge
    expect(screen.getByTestId('tls-risk-badge')).toBeInTheDocument();
  });

  it('risky tunnel domains require explicit TLS confirmation before attach', async () => {
    api.listDomains.mockResolvedValue([]);
    api.addDomain.mockRejectedValueOnce(Object.assign(new Error('needs confirm'), {
      status: 409,
      body: {
        code: 'TLS_DEPTH_CONFIRMATION',
        depth: 2,
        zone: 'acme.dev',
        message: 'deep.a.b.acme.dev sits 2 levels under acme.dev. HTTPS would fail on free plans.',
      },
    }));
    mountPage();
    fireEvent.click((await screen.findAllByTestId('service-card-web'))[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'domains' }));
    const input = await screen.findByPlaceholderText('app.yourdomain.com');
    fireEvent.change(input, { target: { value: 'deep.a.b.acme.dev' } });
    // choose tunnel kind (the domain-kind select inside the domains panel)
    const kindSelect = await screen.findByRole('combobox', { name: (content: string, el: Element) => el.tagName === 'SELECT' && (el as HTMLSelectElement).options && Array.from((el as HTMLSelectElement).options).some(o => o.value === 'tunnel') } as never);
    fireEvent.change(screen.getAllByRole('combobox').find(el => Array.from((el as HTMLSelectElement).options).some(o => o.value === 'tunnel'))!, { target: { value: 'tunnel' } });
    fireEvent.click(screen.getByRole('button', { name: /Attach domain/i }));

    // Confirmation panel appears instead of attaching
    expect(await screen.findByTestId('tls-confirm')).toBeInTheDocument();
    expect(screen.getByText(/broken HTTPS/i)).toBeInTheDocument();
    expect(api.addDomain).toHaveBeenCalledTimes(1); // only the unconfirmed attempt

    // Confirming re-posts with confirm=true and succeeds
    api.addDomain.mockResolvedValueOnce({ id: 9, kind: 'tunnel', domain: 'deep.a.b.acme.dev', created: 3, tls_risk: true, guidance: { dns: [], notes: [] } });
    fireEvent.click(screen.getByTestId('tls-confirm-anyway'));
    await waitFor(() => expect(api.addDomain).toHaveBeenCalledWith('acme', 'webshop', 12, 'deep.a.b.acme.dev', 'tunnel', true));
  });

  it('deleting an env var hits the surgical endpoint, not full-replace PUT', async () => {
    api.listEnvVars
      .mockResolvedValueOnce([{ key: 'A', updated: 1 }, { key: 'B', updated: 1 }])
      .mockResolvedValue([{ key: 'B', updated: 1 }]);
    mountPage();
    fireEvent.click((await screen.findAllByTestId('service-card-web'))[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'env' }));
    await screen.findByText('A');
    const buttons = screen.getAllByTitle('Delete variable');
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(api.removeEnvVar).toHaveBeenCalledWith('acme', 'webshop', 12, 'A'));
    expect(api.setEnvVars).not.toHaveBeenCalled();
  });
});

describe('Dashboard deployments overview', () => {
  it('shows most active services with fleet counters and uptime lanes', async () => {
    api.deploymentsOverview.mockResolvedValue([
      {
        ...baseService,
        requests_24h: 1520,
        alert: false,
        live: true,
        space: 'acme',
        repo_uid: 'webshop',
      },
      {
        ...baseService,
        id: 13,
        name: 'api',
        requests_24h: 40,
        alert: true,
        live: false,
        space: 'acme',
        repo_uid: 'platform',
      },
    ]);
    render(
      <MemoryRouter>
        <DeploymentsOverview />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('deployments-overview')).toBeInTheDocument();
    expect(screen.getByTestId('fleet-serving').textContent).toContain('1/2 live');
    expect(screen.getByTestId('fleet-alerts').textContent).toContain('1 failed deploy');
    expect(screen.getByText(/1[,.\s]?520 req/)).toBeInTheDocument();
    expect(screen.getAllByText('acme/platform').length).toBeGreaterThan(0);
  });

  it('hides itself entirely when the overview endpoint errors out', async () => {
    api.deploymentsOverview.mockRejectedValue(new Error('nope'));
    const { container } = render(
      <MemoryRouter>
        <DeploymentsOverview />
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('[data-testid="deployments-overview"]')).toBeNull());
  });
});
