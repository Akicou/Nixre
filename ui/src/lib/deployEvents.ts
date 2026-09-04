// Live deployment events over SSE — same fetch-reader pattern as agentJobs.ts
// (Authorization header required, so native EventSource can't be used).
import { api } from './api';

export interface DeployEvent {
  type: string; // log | status | metrics | uptime | hello
  ts?: number;
  phase?: 'build' | 'release';
  line?: string;
  status?: string;
  deploymentId?: number | null;
  previousId?: number | null;
  error?: string;
  servingPrevious?: boolean;
  metrics?: { cpuPctOfLimit: number; memUsedBytes: number; memPctOfLimit: number };
}

export function deployEventsUrl(space: string, repo: string, serviceId: number): string {
  return `/api/v1/repos/${space}/${repo}/+/deployments/services/${serviceId}/events`;
}

/**
 * Subscribe to a service's deployment event stream. Returns an unsubscribe
 * function. Reconnects automatically with backoff until unsubscribed, so a
 * long build survives temporary network hiccups.
 */
export function subscribeDeployEvents(
  space: string,
  repo: string,
  serviceId: number,
  onEvent: (evt: DeployEvent) => void,
): () => void {
  const controller = new AbortController();
  let stopped = false;
  let attempt = 0;

  const connect = async () => {
    while (!stopped) {
      try {
        const res = await fetch(deployEventsUrl(space, repo, serviceId), {
          headers: apiHeaders(),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`event stream HTTP ${res.status}`);
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            try {
              onEvent(JSON.parse(line.slice(5).trim()) as DeployEvent);
            } catch {
              /* malformed frame — skip */
            }
          }
        }
      } catch (err) {
        if (stopped || controller.signal.aborted) return;
        // Aborting the fetch throws AbortError when we stop — otherwise retry.
        attempt += 1;
      }
      if (stopped) return;
      await new Promise(r => setTimeout(r, Math.min(5000, 500 * 2 ** attempt)));
    }
  };

  function apiHeaders(): Record<string, string> {
    const token = localStorage.getItem('nixre_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  void connect();

  return () => {
    stopped = true;
    controller.abort();
  };
}
