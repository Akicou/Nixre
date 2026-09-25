// Live deployment events over SSE (see lib/sse.ts).
import { subscribeSse } from './sse';

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
  return subscribeSse<DeployEvent>(deployEventsUrl(space, repo, serviceId), onEvent);
}
