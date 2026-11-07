import React, { useEffect, useState } from 'react';
import { request } from './AgentTaskPanel';

const select = 'min-h-11 max-w-[10rem] rounded-lg bg-transparent px-2 text-xs text-txt-secondary hover:bg-surface-subtle hover:text-txt-primary outline-none cursor-pointer transition disabled:opacity-40 disabled:cursor-default';

// Permission preset picker for the composer. A new task keeps the choice locally and
// sends it with the first message; an existing task reads and saves it on the server.
export function PresetSelect({ conversationId, newPreset, onNewPreset, running }: {
  conversationId: string | null; newPreset: string; onNewPreset: (preset: string) => void; running: boolean;
}) {
  const [settings, setSettings] = useState<{ preset: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setSettings(null); setError('');
    if (!conversationId) return;
    let live = true;
    request(conversationId).then(s => { if (live) setSettings(s.settings); }).catch(err => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [conversationId, running]);
  const change = async (preset: string) => {
    if (!conversationId) return onNewPreset(preset);
    if (!settings) return;
    try { setSettings((await request(conversationId, { type: 'settings', settings: { ...settings, preset } })).settings); setError(''); }
    catch (err) { setError((err as Error).message); }
  };
  return (
    <select
      aria-label={conversationId ? 'Task permissions' : 'New task permissions'}
      title={error || 'What the agent may do: ask first (edits applied, you approve commands), read only, or auto (edits applied, commands reviewed by Jev on OpenRouter)'}
      value={conversationId ? settings?.preset ?? 'workspace' : newPreset}
      disabled={!!conversationId && (running || !settings)}
      onChange={e => void change(e.target.value)}
      className={select}
    >
      <option value="workspace" title="Edits are applied; you approve each command">Ask first</option>
      <option value="read_only" title="The agent can only read">Read only</option>
      <option value="auto" title="Edits are applied; each shell command is reviewed by Jev before it runs (needs an OpenRouter provider)">Auto</option>
    </select>
  );
}
