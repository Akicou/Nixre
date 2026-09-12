import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { api, DeploymentCapabilities, DeployService, RuntimeOptions } from '../lib/api';
import { GuidedServiceModal, ServicePreset } from '../components/GuidedServiceModal';
import { StandaloneServiceDetail } from '../components/StandaloneServiceDetail';
import { SpaceDeployments } from '../components/SpaceDeployments';
import { DeploymentsOverview } from '../components/DeploymentsOverview';

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn(() => vi.fn()) }));
vi.mock('../lib/deployEvents', () => ({ subscribeDeployEvents: subscribe }));

const capabilities: DeploymentCapabilities = { host_mounts: true, bind_allowlist: ['/srv/models'], gpus: true, git_hosts: ['github.com'] };
const service: DeployService = {
  id: 42, name: 'postgres', space_uid: 'lab', source_type: 'image', template: 'postgres', image_ref: 'postgres:17',
  internal_hostname: 'nixre-svc-42', exposure: 'internal', deployment_strategy: 'recreate',
  volume_name: 'nixre-service-42-data', volume_path: '/var/lib/postgresql/data', can_write: true,
  root_dir: '.', dockerfile_path: 'Dockerfile', branch: 'main', auto_deploy: false, container_port: 5432,
  cpu_nano_cpus: 1e9, memory_bytes: 512 * 1048576, desired_state: 'running', status: 'running',
  current_deployment_id: 9, last_failed_deployment_id: null, preserve_status_min: 400,
  success_retention_hours: 24, failure_retention_hours: 168, created: 1, updated: 2,
};
const gitService: DeployService = { ...service, id: 43, name: 'llama-server', source_type: 'git', template: null, image_ref: null,
  git_url: 'https://github.com/ggml-org/llama.cpp', branch: 'master', dockerfile_path: '.devops/cpu.Dockerfile',
  build_target: 'server', volume_path: null, volume_name: null, container_port: 8080,
  runtime_options: { version: 1, health_type: 'http', health_path: '/health', health_timeout_ms: 300000,
    command: ['--model', '/models/model.gguf'], entrypoint: ['/app/llama-server'],
    host_config: { binds: ['/srv/models/model.gguf:/models/model.gguf:ro'], gpus: null, privileged: false,
      cap_add: [], cap_drop: [], devices: [], group_add: [], extra_hosts: [], shm_size: null, tmpfs: {}, network_mode: null },
  } satisfies RuntimeOptions,
};

beforeEach(() => {
  subscribe.mockClear();
  vi.spyOn(api, 'createStandaloneService').mockResolvedValue(service);
  vi.spyOn(api, 'deployService').mockResolvedValue({ deploymentId: 10 });
  vi.spyOn(api, 'getStandaloneService').mockResolvedValue(service);
  vi.spyOn(api, 'patchDeployService').mockResolvedValue(service);
  vi.spyOn(api, 'redeployDeployment').mockResolvedValue({ deploymentId: 10 });
  vi.spyOn(api, 'deleteDeployService').mockResolvedValue();
  vi.spyOn(api, 'getRepo').mockRejectedValue(new Error('Must not request a repository'));
  vi.spyOn(api, 'detectDockerfiles').mockRejectedValue(new Error('Must not inspect a repository'));
  vi.spyOn(api, 'listDeployServices').mockResolvedValue([]);
  vi.spyOn(api, 'listDeployments').mockResolvedValue([]);
  vi.spyOn(api, 'serviceRuntimeLogs').mockResolvedValue({ logs: 'real container output' });
  vi.spyOn(api, 'listDomains').mockResolvedValue([]);
  vi.spyOn(api, 'addDomain').mockResolvedValue({ id: 1, domain: 'app.example.com', kind: 'tunnel', created: 1, verified: false, guidance: { dns: [], notes: [] } });
  vi.spyOn(api, 'verifyDomain').mockResolvedValue({ id: 1, domain: 'app.example.com', verified: false, message: 'TXT record not found' });
  vi.spyOn(api, 'listEnvVars').mockResolvedValue([{ key: 'EXISTING_KEY', updated: 1 }]);
  vi.spyOn(api, 'setEnvVars').mockResolvedValue({ ok: true, keys: [] });
  vi.spyOn(api, 'serviceStats').mockResolvedValue({ limits: { cpu_nano_cpus: 1e9, memory_bytes: 512 * 1048576 }, latest: null, series: [] });
  vi.spyOn(api, 'serviceUptime').mockResolvedValue({ range: '24h', bucket_ms: 900000, buckets: [], uptime_pct: null, checks_total: 0 });
  vi.spyOn(api, 'spaceDeployments').mockResolvedValue({ services: [service, gitService], activity: [], can_write: true, capabilities });
  vi.spyOn(api, 'revealEnvVar').mockImplementation(async (_space, _repo, _id, key) => ({ key, value: ({ POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'test password/@' } as Record<string, string>)[key] || 'test-only-secret' }));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => vi.restoreAllMocks());

function wizard(preset: ServicePreset, policy = capabilities) {
  const onComplete = vi.fn();
  const onClose = vi.fn();
  render(<GuidedServiceModal space="lab" capabilities={policy} initialPreset={preset} onClose={onClose} onComplete={onComplete} />);
  return { onComplete, onClose };
}
function next() { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); }
function change(label: string | RegExp, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function detail(svc = service, canWrite = true, policy = capabilities) {
  vi.mocked(api.getStandaloneService).mockResolvedValue(svc);
  const onChanged = vi.fn();
  const onDeleted = vi.fn();
  render(<StandaloneServiceDetail space="lab" serviceId={svc.id} canWrite={canWrite} capabilities={policy} onChanged={onChanged} onDeleted={onDeleted} />);
  return { onChanged, onDeleted };
}

describe('Guided standalone setup', () => {
  it('creates PostgreSQL from an image, then explicitly deploys without repository requests or preview credentials', async () => {
    const { onComplete } = wizard('postgres');
    next();
    change(/^Database name/, 'catalog');
    change(/^Database user/, 'catalog_user');
    expect(screen.queryByLabelText(/volume size/i)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/test password/)).not.toBeInTheDocument();
    next();
    expect(screen.getByText('/var/lib/postgresql/data')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create and deploy' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(service));
    expect(api.createStandaloneService).toHaveBeenCalledWith('lab', {
      name: 'postgres', source_type: 'image', template: 'postgres', image_ref: 'postgres:17', database: 'catalog', username: 'catalog_user', cpu_cores: 1, memory_mb: 512,
    });
    expect(api.deployService).toHaveBeenCalledWith('lab', null, 42);
    expect(vi.mocked(api.createStandaloneService).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.deployService).mock.invocationCallOrder[0]);
    expect(api.getRepo).not.toHaveBeenCalled();
    expect(api.detectDockerfiles).not.toHaveBeenCalled();
    expect(api.revealEnvVar).not.toHaveBeenCalled();
  });

  it('builds llama.cpp from a full PR ref with explicit CUDA target, resources and read-only GGUF bind', async () => {
    wizard('llama');
    change(/^Deploy from/, 'pr');
    change(/^Pull request number/, '12345');
    next();
    change(/^Compute/, 'gpu');
    change(/^Host GGUF file path/, '/srv/models/qwen.gguf');
    expect(screen.getByDisplayValue('.devops/cuda.Dockerfile')).toBeInTheDocument();
    expect(screen.getByText(/Hardware is not detected or verified/)).toBeInTheDocument();
    next();
    expect(screen.getByText('refs/pull/12345/head')).toBeInTheDocument();
    expect(screen.queryByText(/c7e4a91/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create and deploy' }));
    await waitFor(() => expect(api.createStandaloneService).toHaveBeenCalledWith('lab', expect.objectContaining({
      source_type: 'git', git_url: 'https://github.com/ggml-org/llama.cpp', branch: 'refs/pull/12345/head',
      root_dir: '.', dockerfile_path: '.devops/cuda.Dockerfile', build_target: 'server', memory_mb: 8192,
      exposure: 'internal', deployment_strategy: 'recreate',
      runtime_options: expect.objectContaining({
        health_type: 'http', health_path: '/health', health_timeout_ms: 300000,
        entrypoint: ['/app/llama-server'],
        command: ['--model', '/models/model.gguf', '--host', '0.0.0.0', '--port', '8080', '--ctx-size', '4096', '--n-gpu-layers', '99'],
        host_config: { binds: ['/srv/models/qwen.gguf:/models/model.gguf:ro'], gpus: 'all' },
      }),
    })));
    expect(api.detectDockerfiles).not.toHaveBeenCalled();
  });

  it('uses CPU defaults and rejects paths outside the allowlist or with traversal', async () => {
    wizard('llama'); next();
    change(/^Host GGUF file path/, '/srv/models-other/model.gguf'); next();
    expect(screen.getByRole('alert')).toHaveTextContent('approved prefix');
    change(/^Host GGUF file path/, '/srv/models/../private/model.gguf'); next();
    expect(api.createStandaloneService).not.toHaveBeenCalled();
    change(/^Host GGUF file path/, '/srv/models/model.gguf'); next();
    fireEvent.click(screen.getByRole('button', { name: 'Create and deploy' }));
    await waitFor(() => expect(api.createStandaloneService).toHaveBeenCalledWith('lab', expect.objectContaining({ dockerfile_path: '.devops/cpu.Dockerfile', runtime_options: expect.objectContaining({ host_config: expect.objectContaining({ gpus: null }), command: expect.arrayContaining(['--n-gpu-layers', '0']) }) })));
  });

  it('disables denied host-model setup but leaves generic image creation available', async () => {
    wizard('llama', { ...capabilities, host_mounts: false, bind_allowlist: [], gpus: false });
    expect(screen.getByRole('radio', { name: /llama.cpp/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByText(/Host model setup is disabled/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Container image/ }));
    change(/^Container image and tag/, 'redis:7'); next();
    change(/^Service name/, 'cache');
    change(/^Health check/, 'tcp');
    change(/^Container port/, '6379');
    change(/^Persistent volume mount/, '/data'); next();
    fireEvent.click(screen.getByRole('button', { name: 'Create and deploy' }));
    await waitFor(() => expect(api.createStandaloneService).toHaveBeenCalledWith('lab', expect.objectContaining({ name: 'cache', source_type: 'image', image_ref: 'redis:7', container_port: 6379, volume_path: '/data', runtime_options: expect.objectContaining({ health_type: 'tcp' }) })));
    const input = vi.mocked(api.createStandaloneService).mock.calls[0][1];
    expect(input).not.toHaveProperty('git_url');
    expect(input).not.toHaveProperty('dockerfile_path');
    expect(api.getRepo).not.toHaveBeenCalled();
  });

  it.each(['git', 'image'] as const)('uses recreate for a standalone %s service without offering blue/green', async preset => {
    wizard(preset);
    if (preset === 'git') change(/^Git repository URL/, 'https://github.com/example/app');
    else change(/^Container image and tag/, 'nginx:1.27');
    next();
    change(/^Service name/, 'web');
    change(/^Network access/, 'http');
    expect(screen.queryByRole('combobox', { name: /Release strategy/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Blue\/green/i })).not.toBeInTheDocument();
    expect(screen.getByText(/All standalone services use stop\/start \(recreate\) releases/)).toBeInTheDocument();
    expect(screen.getByText(/Public HTTP may receive an automatic address under the instance base domain/)).toBeInTheDocument();
    next();
    expect(screen.getByText('recreate')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create and deploy' }));
    await waitFor(() => expect(api.createStandaloneService).toHaveBeenCalledWith('lab', expect.objectContaining({
      name: 'web', source_type: preset, exposure: 'http', deployment_strategy: 'recreate', volume_path: null,
    })));
  });

  it('resets runtime defaults when switching between customized llama and container sources', async () => {
    wizard('llama'); next();
    change(/^Compute/, 'gpu');
    change(/^Server entrypoint/, '/app/custom-server');
    change(/^Context size/, '8192');
    change(/^Container port/, '9999');
    change(/^Additional server arguments/, '["--verbose"]');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('radio', { name: /Container image/ }));
    change(/^Container image and tag/, 'redis:7'); next();
    expect(screen.getByLabelText(/^Container port/)).toHaveValue(8080);
    expect(screen.getByLabelText(/^Health check/)).toHaveValue('http');
    expect(screen.getByLabelText(/^Health path/)).toHaveValue('/');
    expect(screen.getByLabelText(/^Startup health timeout/)).toHaveValue(60000);
    expect(screen.getByLabelText(/^Command override/)).toHaveValue('');
    change(/^Health check/, 'tcp');
    change(/^Container port/, '6379');
    change(/^Command override/, '["--appendonly", "yes"]');
    change(/^Persistent volume mount/, '/data');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('radio', { name: /llama.cpp/ })); next();
    expect(screen.getByLabelText(/^Compute/)).toHaveValue('cpu');
    expect(screen.getByLabelText(/^Server entrypoint/)).toHaveValue('/app/llama-server');
    expect(screen.getByLabelText(/^Context size/)).toHaveValue(4096);
    expect(screen.getByLabelText(/^Container port/)).toHaveValue(8080);
    expect(screen.getByLabelText(/^Health path/)).toHaveValue('/health');
    expect(screen.getByLabelText(/^Startup health timeout/)).toHaveValue(300000);
    expect(screen.getByLabelText(/^Additional server arguments/)).toHaveValue('');
    change(/^Host GGUF file path/, '/srv/models/model.gguf'); next();
    fireEvent.click(screen.getByRole('button', { name: 'Create and deploy' }));
    await waitFor(() => expect(api.createStandaloneService).toHaveBeenCalledWith('lab', expect.objectContaining({
      dockerfile_path: '.devops/cpu.Dockerfile', container_port: 8080, volume_path: null,
      runtime_options: expect.objectContaining({
        health_type: 'http', health_path: '/health', health_timeout_ms: 300000,
        entrypoint: ['/app/llama-server'],
        command: ['--model', '/models/model.gguf', '--host', '0.0.0.0', '--port', '8080', '--ctx-size', '4096', '--n-gpu-layers', '0'],
      }),
    })));
  });

  it('keeps a created service ID when deployment fails, allowing retry without duplicate creation', async () => {
    vi.mocked(api.deployService).mockRejectedValueOnce(new Error('Builder unavailable')).mockResolvedValueOnce({ deploymentId: 11 });
    const { onComplete } = wizard('postgres'); next(); next();
    fireEvent.click(screen.getByRole('button', { name: 'Create and deploy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('was created, but deployment was not confirmed');
    expect(screen.getByRole('button', { name: 'Open created service' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry deployment' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(service));
    expect(api.createStandaloneService).toHaveBeenCalledTimes(1);
    expect(api.deployService).toHaveBeenCalledTimes(2);
  });

  it('shows creation errors without issuing deploy and restores focus on Escape', async () => {
    vi.mocked(api.createStandaloneService).mockRejectedValue(new Error('Name already exists'));
    const { onClose } = wizard('postgres'); next(); next();
    fireEvent.click(screen.getByRole('button', { name: 'Create and deploy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Name already exists');
    expect(api.deployService).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not dismiss or create twice while a creation request is pending', async () => {
    let resolve!: (value: DeployService) => void;
    vi.mocked(api.createStandaloneService).mockImplementation(() => new Promise(done => { resolve = done; }));
    const { onClose, onComplete } = wizard('postgres'); next(); next();
    const submit = screen.getByRole('button', { name: 'Create and deploy' });
    fireEvent.click(submit); fireEvent.click(submit);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(submit).toBeDisabled();
    expect(api.createStandaloneService).toHaveBeenCalledTimes(1);
    await act(async () => resolve(service));
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(service));
  });
});

describe('Standalone details and navigation', () => {
  it('copies credentials only after intent, with server hostname and URI escaping; keeps the display masked', async () => {
    detail();
    const copy = await screen.findByRole('button', { name: 'Copy connection URI' });
    expect(api.revealEnvVar).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Connection URI')).toHaveValue('postgresql://USER:********@nixre-svc-42:5432/DATABASE');
    fireEvent.click(copy);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('postgresql://app:test%20password%2F%40@nixre-svc-42:5432/app'));
    expect(api.revealEnvVar).toHaveBeenCalledWith('lab', null, 42, 'POSTGRES_PASSWORD');
    expect(screen.getByLabelText('Connection URI')).toHaveValue('postgresql://USER:********@nixre-svc-42:5432/DATABASE');
    expect(screen.getByText('/var/lib/postgresql/data')).toBeInTheDocument();
    expect(screen.getByText(/No backup configured/)).toBeInTheDocument();
    expect(screen.getByText(/not per-space isolation/)).toBeInTheDocument();
  });

  it('clears revealed credentials on tab changes and blocks PostgreSQL upgrades/rollback', async () => {
    detail();
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal connection' }));
    await waitFor(() => expect((screen.getByLabelText('Connection URI') as HTMLInputElement).value).toContain('test%20password'));
    fireEvent.click(screen.getByRole('button', { name: 'Deployments' }));
    expect(screen.getByRole('button', { name: 'Upgrade version' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rollback' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    expect((screen.getByLabelText('Connection URI') as HTMLInputElement).value).toContain('********');
  });

  it('keeps credentials masked when authorized reveal fails and never copies a fabricated URI', async () => {
    vi.mocked(api.revealEnvVar).mockRejectedValue(new Error('No write access'));
    detail();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy connection URI' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No write access');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Connection URI') as HTMLInputElement).value).toContain('********');
  });

  it('copies actual host mounts, fetches real runtime logs, and merges environment without replacing other keys', async () => {
    detail(gitService);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy mount configuration' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/srv/models/model.gguf:/models/model.gguf:ro'));
    fireEvent.click(screen.getByRole('button', { name: 'Runtime logs' }));
    expect(await screen.findByText('real container output')).toBeInTheDocument();
    expect(api.serviceRuntimeLogs).toHaveBeenCalledWith('lab', null, 43);
    fireEvent.click(screen.getByRole('button', { name: 'Environment' }));
    expect(await screen.findByText('EXISTING_KEY', { selector: 'code' })).toBeVisible();
    expect(api.revealEnvVar).not.toHaveBeenCalled();
    change('Variable name', 'NEW_KEY'); change('Variable value', 'value');
    fireEvent.click(screen.getByRole('button', { name: 'Save variable' }));
    await waitFor(() => expect(api.patchDeployService).toHaveBeenCalledWith('lab', null, 43, { env: { NEW_KEY: 'value' } }));
    expect(api.setEnvVars).not.toHaveBeenCalled();
  });

  it('reports stop errors and applies runtime from the current image with real busy status', async () => {
    vi.mocked(api.patchDeployService).mockRejectedValueOnce(new Error('Container did not stop'));
    detail(gitService);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Container did not stop');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    vi.mocked(api.getStandaloneService).mockResolvedValue({ ...gitService, status: 'deploying' });
    fireEvent.click(screen.getByRole('button', { name: 'Apply runtime' }));
    await waitFor(() => expect(api.redeployDeployment).toHaveBeenCalledWith('lab', null, 43, 9));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rebuild and deploy' })).toBeDisabled());
    expect(api.deployService).not.toHaveBeenCalled();
  });

  it('starts a stopped standalone service and rebuilds through canonical actions', async () => {
    detail({ ...gitService, desired_state: 'stopped', status: 'stopped' });
    const start = await screen.findByRole('button', { name: 'Start' });
    vi.mocked(api.patchDeployService).mockResolvedValue(gitService);
    vi.mocked(api.getStandaloneService).mockResolvedValue(gitService);
    fireEvent.click(start);
    await waitFor(() => expect(api.patchDeployService).toHaveBeenCalledWith('lab', null, 43, { desired_state: 'running' }));
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
    vi.mocked(api.getStandaloneService).mockResolvedValue({ ...gitService, status: 'deploying' });
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild and deploy' }));
    await waitFor(() => expect(api.deployService).toHaveBeenCalledWith('lab', null, 43));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rebuild and deploy' })).toBeDisabled());
  });

  it('lets ordinary writers edit application runtime without resubmitting admin-only normalized defaults', async () => {
    const ordinary = { ...gitService, runtime_options: { ...gitService.runtime_options!, host_config: { ...gitService.runtime_options!.host_config, binds: [] } } };
    detail(ordinary, true, { ...capabilities, host_mounts: false, bind_allowlist: [], gpus: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const input = screen.getByLabelText('Runtime options (JSON)') as HTMLTextAreaElement;
    expect(JSON.parse(input.value)).not.toHaveProperty('host_config');
    change('Runtime options (JSON)', JSON.stringify({ command: ['--help'], health_type: 'tcp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(api.patchDeployService).toHaveBeenCalledWith('lab', null, 43, expect.objectContaining({ runtime_options: { command: ['--help'], health_type: 'tcp' } })));
  });

  it('keeps unverified HTTP domains unrouted and requires explicit TLS-risk acceptance', async () => {
    vi.mocked(api.addDomain).mockRejectedValueOnce(Object.assign(new Error('TLS depth'), { body: { code: 'TLS_DEPTH_CONFIRMATION', message: 'Certificate does not cover this depth.' } }));
    detail({ ...gitService, exposure: 'http' });
    const configure = await screen.findByRole('button', { name: 'Configure HTTP domains' });
    expect(screen.getByText(/Public HTTP may receive an automatic address under the instance base domain/)).toBeInTheDocument();
    fireEvent.click(configure);
    expect(screen.queryByRole('combobox', { name: /Release strategy/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh domains' })).toBeEnabled());
    change('Domain name', 'deep.app.example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Attach domain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Certificate does not cover this depth');
    expect(api.addDomain).toHaveBeenCalledWith('lab', null, 43, 'deep.app.example.com', 'tunnel', false);
    vi.mocked(api.listDomains).mockResolvedValue([{ id: 1, domain: 'deep.app.example.com', kind: 'tunnel', created: 1, verified: false,
      verification: { verified: false, record: { type: 'TXT', name: '_nixre.deep.app.example.com', value: 'test-challenge' } }, guidance: { dns: [], notes: [] },
    }]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept TLS risk and attach' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Accept TLS risk and attach' }));
    await waitFor(() => expect(api.addDomain).toHaveBeenLastCalledWith('lab', null, 43, 'deep.app.example.com', 'tunnel', true));
    expect(await screen.findByText('Awaiting verification; not routed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verify ownership' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('TXT record not found');
    expect(api.verifyDomain).toHaveBeenCalledWith('lab', null, 43, 1);
  });

  it('does not invent health metrics or expose writer actions for read-only viewers', async () => {
    detail(service, false);
    expect(await screen.findAllByText('No sample available')).toHaveLength(2);
    expect(screen.getByText('No checks available')).toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reveal connection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Runtime logs' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('selects a standalone service on the space deployment tab and uses canonical SSE; repo links stay legacy', async () => {
    const legacy = { ...gitService, id: 44, name: 'repo-app', source_type: undefined, repo_uid: 'app', exposure: 'http' as const, deployment_strategy: 'blue_green' as const, internal_hostname: null, domains: [] };
    vi.mocked(api.spaceDeployments).mockResolvedValue({ services: [service, legacy], activity: [], can_write: true, capabilities });
    render(<MemoryRouter initialEntries={['/lab?tab=deployments']}><SpaceDeployments spaceUid="lab" /></MemoryRouter>);
    const standalone = await screen.findByTestId('board-card-postgres');
    expect(standalone).toHaveAttribute('href', '/lab?tab=deployments&service=42');
    expect(screen.getByTestId('board-card-repo-app')).toHaveAttribute('href', '/lab/app?deploys=1&svc=44');
    expect(within(screen.getByTestId('board-card-repo-app')).getByText('HTTP')).toBeInTheDocument();
    expect(screen.queryByText('No domain')).not.toBeInTheDocument();
    fireEvent.click(standalone);
    expect(await screen.findByRole('region', { name: 'Selected service details' })).toBeInTheDocument();
    expect(api.getStandaloneService).toHaveBeenCalledWith('lab', 42);
    expect(subscribe).toHaveBeenCalledWith('lab', null, 42, expect.any(Function));
    expect(api.getRepo).not.toHaveBeenCalled();
  });

  it('labels standalone HTTP access independently of attached custom domains', async () => {
    vi.mocked(api.spaceDeployments).mockResolvedValue({ services: [{ ...gitService, exposure: 'http', domains: [] }], activity: [], can_write: true, capabilities });
    render(<MemoryRouter><SpaceDeployments spaceUid="lab" /></MemoryRouter>);
    const row = await screen.findByTestId('board-card-llama-server');
    expect(within(row).getByText('HTTP')).toBeInTheDocument();
    expect(within(row).queryByText('No domain')).not.toBeInTheDocument();
  });

  it('traps modal focus and restores the board opener after Escape', async () => {
    render(<MemoryRouter initialEntries={['/lab?tab=deployments']}><SpaceDeployments spaceUid="lab" /></MemoryRouter>);
    const opener = await screen.findByRole('button', { name: 'New service' });
    opener.focus(); fireEvent.click(opener);
    const modal = screen.getByRole('dialog');
    const last = within(modal).getByRole('button', { name: 'Continue' });
    last.focus(); fireEvent.keyDown(last, { key: 'Tab' });
    expect(within(modal).getByRole('button', { name: 'Close setup' })).toHaveFocus();
    fireEvent.keyDown(modal, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('uses backend can_write rather than public-space guesses for creation', async () => {
    vi.mocked(api.spaceDeployments).mockResolvedValue({ services: [], activity: [], can_write: false, capabilities });
    render(<MemoryRouter><SpaceDeployments spaceUid="lab" /></MemoryRouter>);
    await screen.findByTestId('space-deployments-board');
    expect(screen.queryByRole('button', { name: 'New service' })).not.toBeInTheDocument();
    expect(screen.getByText(/Read-only deployment access/)).toBeInTheDocument();
  });

  it('links image services from the dashboard and requests uptime without a repository', async () => {
    vi.spyOn(api, 'deploymentsOverview').mockResolvedValue([service]);
    render(<MemoryRouter><DeploymentsOverview /></MemoryRouter>);
    const overview = await screen.findByTestId('deployments-overview');
    expect(within(overview).getByRole('link')).toHaveAttribute('href', '/lab?tab=deployments&service=42');
    expect(api.serviceUptime).toHaveBeenCalledWith('lab', null, 42, '24h');
    expect(within(overview).getByText('Image / postgres:17')).toBeInTheDocument();
    expect(within(overview).getByText('Internal')).toBeInTheDocument();
    expect(overview.querySelector('a a')).toBeNull();
  });
});
