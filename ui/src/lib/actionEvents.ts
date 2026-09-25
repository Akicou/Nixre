// Live Nixre Actions run events (log lines, job and run status) over SSE.
import { subscribeSse } from './sse';

export interface ActionEvent {
  type: 'hello' | 'log' | 'job' | 'run' | 'end';
  ts?: number;
  jobId?: number;
  step?: number;
  line?: string;
  status?: string;
  conclusion?: string | null;
  steps?: { name: string; status: string; conclusion: string | null; started?: number | null; finished?: number | null }[];
}

export function subscribeRunEvents(repoRef: string, runNumber: number, onEvent: (evt: ActionEvent) => void): () => void {
  return subscribeSse<ActionEvent>(`/api/v1/repos/${repoRef}/+/actions/runs/${runNumber}/events`, onEvent);
}
