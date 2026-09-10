import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ToolCall } from '../../lib/assistantEngine';

const notified = new Set<string>();

/** Approval belongs to the command, not to an optional task-settings panel. */
export function CommandApproval({ tool }: { tool: ToolCall }) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(true);
  const review = () => {
    ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    ref.current?.focus({ preventScroll: true });
    setToast(false);
  };
  useEffect(() => {
    const key = `${tool.conversationId}:${tool.approvalId}`;
    if (notified.has(key)) return;
    notified.add(key);
    // Keep the deduplication cache bounded in long-lived tabs.
    if (notified.size > 200) notified.delete(notified.values().next().value!);
    if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const notification = new Notification('Nixre needs your approval', {
          body: `Review ${tool.name} before it runs.`, tag: key,
        });
        notification.onclick = () => { window.focus(); review(); notification.close(); };
        return () => notification.close();
      } catch { /* The in-app notification remains available. */ }
    }
  }, [tool.approvalId, tool.conversationId, tool.name]);

  const decide = async (accept: boolean) => {
    if (busy || decision) return;
    setBusy(true); setError('');
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15_000);
    try {
      const response = await fetch(`/api/v1/ai/jobs/${encodeURIComponent(tool.conversationId!)}/controls`, {
        method: 'POST', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('nixre_token') || ''}` },
        body: JSON.stringify({ type: 'approval', id: tool.approvalId, accept }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Could not send approval');
      setDecision(accept ? 'Approved. The command can now run.' : 'Denied. The command will not run.');
      setToast(false);
    } catch (err) {
      setError(abort.signal.aborted ? 'No response received. Refresh to check whether your decision was received.' : (err as Error).message);
    } finally { clearTimeout(timeout); setBusy(false); }
  };
  let command = tool.argsText || '{}';
  try {
    const args = JSON.parse(command);
    command = typeof args.command === 'string' ? args.command : JSON.stringify(args, null, 2);
  } catch { /* Display the original arguments. */ }
  return <>
    <div ref={ref} tabIndex={-1} aria-label={`Approval for ${tool.name}`} className="px-3 py-3 space-y-3 border-t border-brand/40">
      <p role="status" className="text-xs font-semibold text-brand">{decision || 'Waiting for your approval — this command has not run.'}</p>
      <pre className="text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto text-txt-primary">{command}</pre>
      {error && <p role="alert" className="text-xs text-feedback-error-text">{error}</p>}
      {!decision && <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => void decide(true)} className="px-3 py-2 rounded bg-brand text-white text-xs disabled:opacity-50">{busy ? 'Sending…' : 'Approve command'}</button>
        <button type="button" disabled={busy} onClick={() => void decide(false)} className="px-3 py-2 rounded border border-border-subtle text-txt-primary text-xs disabled:opacity-50">Deny command</button>
      </div>}
    </div>
    {toast && !decision && createPortal(<div role="alert" className="fixed bottom-5 right-5 z-50 max-w-sm border border-brand bg-surface-canvas p-4 rounded-lg text-txt-primary space-y-2">
      <p className="text-sm font-semibold">Command approval needed</p>
      <p className="text-xs">The agent is waiting to run {tool.name}.</p>
      <button type="button" onClick={review} className="text-xs font-semibold text-brand underline">Review command</button>
    </div>, document.body)}
  </>;
}
