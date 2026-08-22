import React, { useEffect, useState } from 'react';
import {
  Check,
  Bot,
  Loader2,
  RefreshCw,
  AlertTriangle,
  Zap,
  Plus,
  Trash2,
  Star,
} from 'lucide-react';
import {
  listAiProviders,
  createAiProvider,
  updateAiProvider,
  deleteAiProvider,
  fetchProviderModels,
  isLocalKind,
  LOCAL_MODEL,
  modelLabel,
  type AiProvider,
} from '../../lib/aiApi';
import { PluginConfigForm } from '../PluginConfigForm';
import { getPlugin } from '../../lib/plugins';
import { defaultRepoProfile, getRepoProfile, setRepoProfile, type AssistantRepoProfile } from '../../lib/assistantProfiles';

interface AssistantProfileFormProps {
  mode?: 'full' | 'provider';
  repoPath?: string;
  onClose?: () => void;
}

const PROVIDER_KINDS: { id: string; label: string; hint?: string }[] = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'ollama', label: 'Ollama (local)', hint: 'no key needed on localhost' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', hint: 'base URL required' },
];

const inputCls =
  'w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition outline-none';

/**
 * Multi-provider manager: add several AI providers (each validated + model-
 * fetched server-side), pick which models are enabled for chat, and choose
 * the active provider. Keys are encrypted at rest and never returned.
 */
export const AssistantProfileForm: React.FC<AssistantProfileFormProps> = ({
  mode = 'full',
  repoPath,
  onClose,
}) => {
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // Add-provider draft
  const [adding, setAdding] = useState(false);
  const [draftKind, setDraftKind] = useState('deepseek');
  const [draftLabel, setDraftLabel] = useState('');
  const [draftUrl, setDraftUrl] = useState('');
  const [draftKey, setDraftKey] = useState('');
  const [creating, setCreating] = useState(false);

  const [repoProfile, setRepoProfileState] = useState<AssistantRepoProfile>(() => defaultRepoProfile());

  const reload = async () => {
    try {
      setProviders(await listAiProviders());
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message || 'Could not load providers.' });
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await reload();
      if (repoPath) {
        const repo = await getRepoProfile(repoPath).catch(() => undefined);
        if (repo && !cancelled) setRepoProfileState(repo);
      }
    })().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const handleAdd = async () => {
    setCreating(true);
    setFeedback(null);
    try {
      const kind = PROVIDER_KINDS.find(p => p.id === draftKind)!;
      const created = await createAiProvider({
        label: draftLabel.trim() || kind.label,
        provider: draftKind,
        baseUrl: draftUrl.trim() || undefined,
        apiKey: draftKey.trim(),
      });
      setProviders(prev => [...prev, created]);
      setFeedback({
        kind: 'ok',
        text: `${created.label} validated — ${created.models.length} models fetched, first ${created.enabledModels.length} enabled for chat.`,
      });
      setAdding(false);
      setDraftLabel('');
      setDraftUrl('');
      setDraftKey('');
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message || 'Adding the provider failed.' });
    } finally {
      setCreating(false);
    }
  };

  const refreshModels = async (p: AiProvider) => {
    setBusyId(p.id);
    try {
      const { models } = await fetchProviderModels(p.id, true);
      setProviders(prev =>
        prev.map(x => (x.id === p.id ? { ...x, models, enabledModels: x.enabledModels.filter(m => models.includes(m)) } : x)),
      );
      setFeedback({ kind: 'ok', text: `${p.label}: ${models.length} models fetched.` });
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message || 'Fetching models failed.' });
    } finally {
      setBusyId(null);
    }
  };

  const toggleModel = async (p: AiProvider, model: string) => {
    const enabled = p.enabledModels.includes(model)
      ? p.enabledModels.filter(m => m !== model)
      : [...p.enabledModels, model];
    // Keep a default model whenever possible.
    const defaultModel = enabled.includes(p.defaultModel) ? p.defaultModel : enabled[0] ?? '';
    setProviders(prev => prev.map(x => (x.id === p.id ? { ...x, enabledModels: enabled, defaultModel } : x)));
    try {
      await updateAiProvider(p.id, { enabledModels: enabled, defaultModel });
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message || 'Saving the model selection failed.' });
    }
  };

  const makeDefault = async (p: AiProvider) => {
    setProviders(prev => prev.map(x => ({ ...x, isDefault: x.id === p.id })));
    try {
      await updateAiProvider(p.id, { isDefault: true });
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message || 'Could not set the active provider.' });
    }
  };

  const removeProvider = async (p: AiProvider) => {
    setBusyId(p.id);
    try {
      await deleteAiProvider(p.id);
      await reload();
      setFeedback({ kind: 'ok', text: `${p.label} removed.` });
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message || 'Removing the provider failed.' });
    } finally {
      setBusyId(null);
    }
  };

  const saveRepoProfile = async () => {
    if (repoPath) await setRepoProfile(repoPath, repoProfile).catch(() => {});
  };

  if (loading) {
    return (
      <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 flex items-center justify-center gap-2 text-xs text-txt-tertiary">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading assistant configuration…
      </div>
    );
  }

  return (
    <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded bg-surface-subtle border border-border-subtle text-txt-brand">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-txt-primary uppercase tracking-wider">Nixre Assistant</h2>
            <p className="text-xs text-txt-secondary mt-0.5">
              Add providers, fetch their models, and enable the ones you want to chat with. Keys are stored encrypted server-side.
            </p>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs font-medium text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
          >
            Close
          </button>
        )}
      </div>

      {feedback && (
        <div
          className={`p-3 rounded border text-xs flex items-start gap-2 ${
            feedback.kind === 'ok'
              ? 'bg-feedback-success-bg border-feedback-success-border text-feedback-success-text'
              : 'bg-feedback-error-bg border-feedback-error-border text-feedback-error-text'
          }`}
        >
          {feedback.kind === 'ok' ? <Check className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Provider list */}
      <div className="space-y-3">
        {providers.length === 0 && !adding && (
          <div className="border border-dashed border-border-subtle rounded-lg p-8 text-center">
            <p className="text-xs text-txt-secondary">
              No AI providers yet. Add one — it gets validated against the live provider and its model list is fetched automatically.
            </p>
            <button
              onClick={() => setAdding(true)}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand-hover transition shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              Add provider
            </button>
          </div>
        )}

        {providers.map(p => (
          <div key={p.id} className={`rounded-lg border bg-surface-base transition ${p.isDefault ? 'border-brand/40' : 'border-border-subtle'}`}>
            {/* Provider header */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border-subtle">
              <div className="flex items-center gap-2.5 min-w-0">
                <button
                  onClick={() => makeDefault(p)}
                  title={p.isDefault ? 'Active provider' : 'Make active'}
                  className={`shrink-0 transition ${p.isDefault ? 'text-brand' : 'text-txt-tertiary hover:text-txt-secondary'}`}
                >
                  <Star className={`w-4 h-4 ${p.isDefault ? 'fill-current' : ''}`} />
                </button>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-txt-primary truncate">
                    {p.label}
                    <span className="ml-2 text-[10px] font-mono uppercase text-txt-tertiary">{p.provider}</span>
                    {p.isDefault && <span className="ml-2 text-[10px] font-mono text-brand">ACTIVE</span>}
                  </div>
                  <div className="text-[10px] text-txt-tertiary font-mono truncate">
                    {p.keyMask ? `key ${p.keyMask}` : 'no key'}
                    {p.validatedAt ? ` · validated ${new Date(p.validatedAt).toLocaleDateString()}` : ' · not validated'}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => refreshModels(p)}
                  disabled={busyId === p.id}
                  title="Fetch the live model list"
                  className="p-1.5 rounded hover:bg-surface-subtle text-txt-secondary transition disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${busyId === p.id ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => removeProvider(p)}
                  title="Remove provider"
                  className="p-1.5 rounded hover:bg-feedback-error-bg text-txt-tertiary hover:text-feedback-error-text transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Model picker */}
            <div className="px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider">
                  Models — enable the ones you want to chat with
                </span>
                <span className="text-[10px] text-txt-tertiary font-mono">
                  {p.enabledModels.length}/{p.models.length} enabled
                </span>
              </div>
              {(() => {
                // Local inference servers (llama.cpp, Unsloth, LM Studio…)
                // can serve "whatever is loaded right now" via the sentinel.
                const list = isLocalKind(p.provider)
                  ? [LOCAL_MODEL, ...p.models.filter(m => m !== LOCAL_MODEL)]
                  : p.models;
                if (list.length === 0) {
                  return (
                    <p className="text-[11px] text-txt-tertiary italic">
                      No models yet — hit the refresh button to fetch them from the provider.
                    </p>
                  );
                }
                return (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-44 overflow-y-auto">
                    {list.map(m => {
                      const on = p.enabledModels.includes(m);
                      const isSentinel = m === LOCAL_MODEL;
                      return (
                        <button
                          key={m}
                          onClick={() => toggleModel(p, m)}
                          title={
                            isSentinel
                              ? 'Always answers with the model the server currently has loaded — no need to re-pick when you switch models server-side'
                              : m
                          }
                          className={`flex items-center gap-2 text-left text-[11px] font-mono px-2.5 py-1.5 rounded border transition ${
                            on
                              ? 'bg-brand/10 border-brand/40 text-txt-primary'
                              : 'border-border-subtle text-txt-tertiary hover:text-txt-secondary hover:border-border-mid'
                          } ${isSentinel ? 'border-dashed' : ''}`}
                        >
                          <span
                            className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                              on ? 'bg-brand border-brand' : 'border-border-mid'
                            }`}
                          >
                            {on && <Check className="w-2.5 h-2.5 text-white" />}
                          </span>
                          <span className="truncate">
                            {isSentinel ? (
                              <>
                                <span className="not-italic font-semibold">{modelLabel(m)}</span>
                                <span className="text-txt-tertiary"> — follow the server</span>
                              </>
                            ) : (
                              m
                            )}
                          </span>
                          {p.defaultModel === m && <span className="ml-auto text-[9px] uppercase text-brand shrink-0">default</span>}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        ))}

        {/* Add form */}
        {adding ? (
          <div className="rounded-lg border border-brand/40 bg-surface-base p-4 space-y-3">
            <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider">Add a provider</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="space-y-1.5">
                <span className="text-[11px] text-txt-secondary">Kind</span>
                <select value={draftKind} onChange={e => setDraftKind(e.target.value)} className={inputCls}>
                  {PROVIDER_KINDS.map(k => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] text-txt-secondary">Name (optional)</span>
                <input value={draftLabel} onChange={e => setDraftLabel(e.target.value)} placeholder="e.g. My DeepSeek" className={inputCls} />
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] text-txt-secondary">Base URL (custom only)</span>
                <input value={draftUrl} onChange={e => setDraftUrl(e.target.value)} placeholder="https://api.example.com" className={inputCls} />
              </label>
            </div>
            <label className="block space-y-1.5">
              <span className="text-[11px] text-txt-secondary">
                API Key <span className="text-txt-tertiary">(validated against the provider before saving)</span>
              </span>
              <input
                type="password"
                value={draftKey}
                onChange={e => setDraftKey(e.target.value)}
                placeholder={draftKind === 'ollama' ? 'not needed for local Ollama' : 'sk-…'}
                className={inputCls}
                autoComplete="off"
              />
            </label>
            <div className="flex items-center gap-2 justify-end">
              <button onClick={() => setAdding(false)} className="px-3 py-1.5 rounded text-xs text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition">
                Cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={creating || (draftKind !== 'ollama' && !draftKey.trim()) || (draftKind === 'custom' && !draftUrl.trim())}
                className="px-4 py-1.5 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition shadow-sm flex items-center gap-1.5"
              >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                {creating ? 'Validating…' : 'Validate & add'}
              </button>
            </div>
          </div>
        ) : (
          providers.length > 0 && (
            <button
              onClick={() => setAdding(true)}
              className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg border border-dashed border-border-subtle text-xs text-txt-secondary hover:border-brand/50 hover:text-txt-primary transition"
            >
              <Plus className="w-3.5 h-3.5" />
              Add another provider
            </button>
          )
        )}
      </div>

      {/* Per-repo access profile (full mode only) */}
      {mode === 'full' && repoPath && (
        <PluginConfigForm
          title="Repository Access Profile"
          description={`What the assistant may do in ${repoPath}.`}
          fields={getPlugin('nixre-assistant')?.accessFields ?? []}
          initial={repoProfile as unknown as Record<string, string | number | boolean>}
          onSubmit={values => {
            setRepoProfileState(values as unknown as AssistantRepoProfile);
            saveRepoProfile();
          }}
          onSubmitLabel="Save access profile"
        />
      )}
    </div>
  );
};
