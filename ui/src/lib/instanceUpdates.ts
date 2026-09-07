export interface UpdatePlan {
  id: string; createdAt: number; base: string; target: string; available: boolean;
  files: { status: string; path: string }[]; totalFiles: number; migrations: string[]; ciUrl: string;
}
export interface UpdateJob {
  id: string; actor: string; startedAt: number; finishedAt?: number;
  status: 'checking' | 'checked' | 'running' | 'succeeded' | 'failed' | 'recovery_required';
  steps: { name: string; status: 'running' | 'passed' | 'failed'; message?: string }[];
  plan?: UpdatePlan; message?: string; backup?: string; database?: string; migrations?: string[]; cleanupWarning?: string;
}
export interface UpdateState {
  enabled: boolean; current?: UpdateJob; watchToken?: string; message?: string;
  history?: Pick<UpdateJob, 'id' | 'status' | 'actor' | 'startedAt' | 'message'>[];
}
const key = 'nixre_update_observer';
export function rememberUpdate(token?: string) {
  if (token) sessionStorage.setItem(key, token);
}
export async function observeUpdate(): Promise<UpdateJob> {
  const token = sessionStorage.getItem(key);
  if (!token) throw new Error('Open Instance updates in Admin and reconnect to authorize this browser.');
  const response = await fetch('/update-status/current', { headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    if (response.status === 401 || response.status === 410) throw new Error('Progress access expired. Reconnect from Admin, or use the host recovery guide if the backend is unavailable.');
    throw new Error('Progress connection lost. Retrying; the update may still be running.');
  }
  return response.json();
}
