import React, { useEffect, useState } from 'react';
import { Check, Bot, Loader2, RefreshCw, AlertTriangle, XCircle, Zap } from 'lucide-react';
import { getPlugin } from '../../lib/plugins';
import {
  defaultRepoProfile,
  getActiveProviderProfile,
  getRepoProfile,
  setActiveProviderProfile,
  setRepoProfile,
  type AssistantProviderProfile,
  type AssistantRepoProfile,
} from '../../lib/assistantProfiles';
import { listAiModels } from '../../lib/aiApi';
import { PluginConfigForm } from '../PluginConfigForm';

interface AssistantProfileFormProps {
  // 'full' manages both the provider profile and the per-repo access profile.
  // 'provider' manages only the active AI-provider profile.
  mode?: 'full' | 'provider';
  repoPath?: string;
  onClose?: () => void;
  onSaved?: (profile: AssistantProviderProfile) => void;
}

const REASONING_OPTIONS = ['none', 'low', 'medium', 'high'];

export const AssistantProfileForm: React.FC<AssistantProfileFormProps> = ({
  mode = 'full',
  repoPath,
  onClose,
  onSaved,
}) => {
  const provider = getPlugin('nixre-assistant');
  const providerField = provider?.providerFields?.find(f => f.key === 'provider');
  const providerOptions = providerField?.options ?? ['deepseek', 'openai', 'anthropic', 'ollama', 'custom'];

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [prov, setProv] = useState('deepseek');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [reasoning, setReasoning] = useState('none');
  const [interleaved, setInterleaved] = useState(false);

  const [keyMask, setKeyMask] = useState<string | null>(null);
  const [validatedAt, setValidatedAt] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [repoProfile, setRepoProfileState] = useState<AssistantRepoProfile>(() => defaultRepoProfile());

  useEffect(() => {
    let cancelled = false;
    Promise.all([getActiveProviderProfile(), repoPath ? getRepoProfile(repoPath) : undefined])
      .then(([profile, repo]) => {
        if (cancelled) return;
        setProv(profile.provider);
        setBaseUrl(profile.baseUrl);
        setModel(profile.model);
        setModels(profile.models);
        setReasoning(profile.reasoningLevel);
        setInterleaved(profile.interleavedReasoning);
        setKeyMask(profile.keyMask);
        setValidatedAt(profile.validatedAt);
        if (repo) setRepoProfileState(repo);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const refreshModels = async () => {
    setRefreshing(true);
    try {
      const { models: list } = await listAiModels();
      setModels(list);
      if (list.length > 0 && !list.includes(model)) {
        setModel(list[0]);
      }
      setFeedback({ kind: 'ok', text: `${list.length} models fetched from the provider.` });
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message || 'Could not fetch models.' });
    } finally {
      setRefreshing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const saved = await setActiveProviderProfile(
        {
          provider: prov,
          baseUrl,
          model,
          temperature: 0.2,
          maxTokens: 8192,
          reasoningLevel: reasoning,
          interleavedReasoning: interleaved,
          keyConfigured: false,
          keyMask: null,
          validatedAt: null,
          models,
        },
        apiKey || undefined,
      );
      setModels(saved.models);
      setModel(saved.model);
      setKeyMask(saved.keyMask);
      setValidatedAt(saved.validatedAt);
      setApiKey('');
      if (repoPath) await setRepoProfile(repoPath, repoProfile);
      if (saved.validated) {
        setFeedback({ kind: 'ok', text: `Credentials validated — ${saved.models.length} models available.` });
      } else {
        setFeedback({ kind: 'error', text: 'Saved, but the provider is not validated yet. Enter an API key and save again.' });
      }
      onSaved?.(saved);
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err.message || 'Saving failed.' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 flex items-center justify-center gap-2 text-xs text-txt-tertiary">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading assistant profile…
      </div>
    );
  }

  const inputCls =
    'w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition outline-none';

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
              Credentials are stored encrypted server-side and validated against the live provider.
            </p>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs font-medium text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
          >
            Cancel
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

      {/* Provider profile */}
      <div className="space-y-4 p-4 rounded bg-surface-base border border-border-subtle">
        <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider">AI Provider Profile</div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block space-y-1.5">
            <span className="text-xs text-txt-secondary">Provider</span>
            <select value={prov} onChange={e => setProv(e.target.value)} className={inputCls}>
              {providerOptions.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs text-txt-secondary">
              API Key {keyMask && <span className="text-txt-tertiary font-mono">(saved {keyMask})</span>}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={keyMask ? 'leave blank to keep the saved key' : 'sk-…'}
              className={inputCls}
              autoComplete="off"
            />
          </label>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs text-txt-secondary">
            Base URL <span className="text-txt-tertiary">(required for “custom”, optional otherwise)</span>
          </span>
          <input
            type="text"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com"
            className={inputCls}
          />
        </label>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-txt-secondary">Model</span>
            <button
              type="button"
              onClick={refreshModels}
              disabled={refreshing}
              className="flex items-center gap-1 text-[11px] text-txt-secondary hover:text-txt-primary transition disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
              Fetch models
            </button>
          </div>
          {models.length > 0 ? (
            <select value={model} onChange={e => setModel(e.target.value)} className={inputCls}>
              {models.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="save a validated key first, or type a model id"
                className={inputCls}
              />
            </div>
          )}
          {validatedAt && (
            <p className="text-[11px] text-txt-open flex items-center gap-1">
              <Zap className="w-3 h-3" /> credentials validated {new Date(validatedAt).toLocaleString()}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block space-y-1.5">
            <span className="text-xs text-txt-secondary">Reasoning Level</span>
            <select value={reasoning} onChange={e => setReasoning(e.target.value)} className={inputCls}>
              {REASONING_OPTIONS.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 pt-5 cursor-pointer">
            <input
              type="checkbox"
              checked={interleaved}
              onChange={e => setInterleaved(e.target.checked)}
              className="accent-brand w-3.5 h-3.5"
            />
            <span className="text-xs text-txt-secondary">Interleaved reasoning (stream thinking inline)</span>
          </label>
        </div>
      </div>

      {/* Per-repo access profile (full mode only) */}
      {mode === 'full' && (
        <PluginConfigForm
          title="Repository Access Profile"
          description={`What the assistant may do in ${repoPath ?? 'this repository'}.`}
          fields={provider?.accessFields ?? []}
          initial={repoProfile as unknown as Record<string, string | number | boolean>}
          onSubmit={values => setRepoProfileState(values as unknown as AssistantRepoProfile)}
          onSubmitLabel="Stage access profile"
        />
      )}

      <div className="flex justify-end pt-2">
        <button
          type="button"
          disabled={saving}
          onClick={handleSave}
          className="px-4 py-2 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition shadow-sm flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          <span>{saving ? 'Validating & saving…' : 'Validate & save'}</span>
        </button>
      </div>

      {!validatedAt && !saving && (
        <p className="text-[11px] text-txt-tertiary flex items-center gap-1.5">
          <XCircle className="w-3.5 h-3.5" />
          Until a key is validated the assistant runs in demo mode (canned responses).
        </p>
      )}
    </div>
  );
};
