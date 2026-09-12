import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { deployEventsUrl, subscribeDeployEvents } from '../lib/deployEvents';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('Deployment API scoping', () => {
  it('preserves repository paths and shares canonical space paths for all standalone suffixes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    await api.listDeployServices('lab', 'web');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/repos/lab/web/+/deployments/services', expect.any(Object));
    await api.createStandaloneService('lab', { name: 'db', source_type: 'image', template: 'postgres', image_ref: 'postgres:17', cpu_cores: 1, memory_mb: 512 });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/spaces/lab/deployments/services', expect.objectContaining({ method: 'POST' }));
    const prefix = '/api/v1/spaces/lab/deployments/services/42';
    await api.getStandaloneService('lab', 42);
    expect(fetchMock).toHaveBeenLastCalledWith(prefix, expect.any(Object));
    await api.patchDeployService('lab', null, 42, { desired_state: 'stopped' });
    expect(fetchMock).toHaveBeenLastCalledWith(prefix, expect.objectContaining({ method: 'PATCH' }));
    await api.deployService('lab', null, 42);
    expect(fetchMock).toHaveBeenLastCalledWith(`${prefix}/deploy`, expect.objectContaining({ method: 'POST' }));
    await api.listDeployments('lab', null, 42);
    expect(fetchMock).toHaveBeenLastCalledWith(`${prefix}/deployments?limit=30`, expect.any(Object));
    await api.getDeployment('lab', null, 42, 9);
    expect(fetchMock).toHaveBeenLastCalledWith(`${prefix}/deployments/9`, expect.any(Object));
    await api.redeployDeployment('lab', null, 42, 9);
    expect(fetchMock).toHaveBeenLastCalledWith(`${prefix}/deployments/9/redeploy`, expect.objectContaining({ method: 'POST' }));
    await api.listEnvVars('lab', null, 42);
    expect(fetchMock).toHaveBeenLastCalledWith(`${prefix}/env`, expect.any(Object));
    await api.revealEnvVar('lab', null, 42, 'POSTGRES_PASSWORD');
    expect(fetchMock).toHaveBeenLastCalledWith(`${prefix}/env/POSTGRES_PASSWORD/reveal`, expect.any(Object));
    await api.serviceRuntimeLogs('lab', null, 42);
    expect(fetchMock).toHaveBeenLastCalledWith(`${prefix}/runtime-logs`, expect.any(Object));
    await api.serviceStats('lab', null, 42);
    expect(fetchMock).toHaveBeenLastCalledWith(`${prefix}/stats`, expect.any(Object));
    await api.serviceUptime('lab', null, 42);
    expect(fetchMock).toHaveBeenLastCalledWith(`${prefix}/uptime?range=24h`, expect.any(Object));
    await api.listDomains('lab', null, 42);
    expect(fetchMock).toHaveBeenLastCalledWith(`${prefix}/domains`, expect.any(Object));
    await api.httpLogs('lab', null, 42, { min_status: 500 });
    expect(fetchMock).toHaveBeenLastCalledWith(`${prefix}/http-logs?min_status=500`, expect.any(Object));
    await api.deleteDeployService('lab', null, 42);
    expect(fetchMock).toHaveBeenLastCalledWith(prefix, expect.objectContaining({ method: 'DELETE' }));
  });

  it('uses authenticated canonical SSE and aborts when unsubscribed, without changing legacy URLs', () => {
    expect(deployEventsUrl('lab', 'web', 42)).toBe('/api/v1/repos/lab/web/+/deployments/services/42/events');
    expect(deployEventsUrl('a b', null, 42)).toBe('/api/v1/spaces/a%20b/deployments/services/42/events');
    localStorage.setItem('nixre_token', 'test-session');
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const off = subscribeDeployEvents('lab', null, 42, vi.fn());
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/spaces/lab/deployments/services/42/events', expect.objectContaining({ headers: { Authorization: 'Bearer test-session' } }));
    const signal = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal;
    off();
    expect(signal?.aborted).toBe(true);
  });
});
