import React, { useState } from 'react';
import { Check, Bot } from 'lucide-react';
import { getPlugin } from '../../lib/plugins';
import {
  defaultProviderProfile,
  defaultRepoProfile,
  getActiveProviderProfile,
  getRepoProfile,
  setActiveProviderProfile,
  setRepoProfile,
  type AssistantProviderProfile,
  type AssistantRepoProfile,
} from '../../lib/assistantProfiles';
import { PluginConfigForm } from '../PluginConfigForm';

interface AssistantProfileFormProps {
  // 'full' manages both the provider profile and the per-repo access profile.
  // 'provider' manages only the active AI-provider profile.
  mode?: 'full' | 'provider';
  repoPath?: string;
  onClose?: () => void;
}

export const AssistantProfileForm: React.FC<AssistantProfileFormProps> = ({
  mode = 'full',
  repoPath,
  onClose,
}) => {
  const provider = getPlugin('nixre-assistant');
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [providerProfile, setProviderProfile] = useState<AssistantProviderProfile>(() => getActiveProviderProfile());
  const [repoProfile, setRepoProfileState] = useState<AssistantRepoProfile>(() => {
    if (repoPath) return getRepoProfile(repoPath) ?? defaultRepoProfile();
    return defaultRepoProfile();
  });

  const handleSave = async () => {
    setSubmitting(true);
    try {
      setActiveProviderProfile(providerProfile);
      if (repoPath) setRepoProfile(repoPath, repoProfile);
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } finally {
      setSubmitting(false);
    }
  };

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
              The active profile selects the AI provider; per-repo settings control what the assistant may do.
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

      {saved && (
        <div className="p-3 rounded bg-feedback-success-bg border border-feedback-success-border text-feedback-success-text text-xs flex items-center gap-2">
          <Check className="w-4 h-4 shrink-0" />
          <span>Assistant profile saved.</span>
        </div>
      )}

      <PluginConfigForm
        title="AI Provider Profile"
        description="Which provider, model and credentials drive the assistant."
        fields={provider?.providerFields ?? []}
        initial={providerProfile as unknown as Record<string, string | number | boolean>}
        onSubmit={values => setProviderProfile(values as unknown as AssistantProviderProfile)}
        onSubmitLabel="Save provider"
        submitting={submitting}
      />

      {mode === 'full' && (
        <PluginConfigForm
          title="Repository Access Profile"
          description={`What the assistant may do in ${repoPath ?? 'this repository'}.`}
          fields={provider?.accessFields ?? []}
          initial={repoProfile as unknown as Record<string, string | number | boolean>}
          onSubmit={values => setRepoProfileState(values as unknown as AssistantRepoProfile)}
          onSubmitLabel="Save access profile"
          submitting={submitting}
        />
      )}

      {mode === 'full' && (
        <div className="flex justify-end pt-2">
          <button
            type="button"
            disabled={submitting}
            onClick={handleSave}
            className="px-4 py-2 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition shadow-sm flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            <span>{submitting ? 'Saving...' : 'Save both profiles'}</span>
          </button>
        </div>
      )}
    </div>
  );
};
