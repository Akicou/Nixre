import React, { useState } from 'react';
import { Settings2, Shield, Check, Info } from 'lucide-react';
import { PLUGINS, getPlugin, isAssistantPlugin } from '../lib/plugins';
import {
  setServerAvailablePlugin,
  setUserEnabledPlugin,
  setPluginConfig,
  getPluginConfig,
  getServerAvailableIds,
  getUserEnabledIds,
} from '../lib/pluginPreferences';
import { PluginToggle } from '../components/PluginToggle';
import { PluginConfigForm } from '../components/PluginConfigForm';
import { AssistantProfileForm } from '../components/assistant/AssistantProfileForm';

export const Plugins: React.FC = () => {
  // Mirror the localStorage layers in state so toggles update the UI immediately.
  const [available, setAvailable] = useState<string[]>(() => getServerAvailableIds());
  const [enabled, setEnabled] = useState<string[]>(() => getUserEnabledIds());
  const [configuringId, setConfiguringId] = useState<string | null>(null);

  const configuredPlugin = configuringId ? getPlugin(configuringId) : null;

  const handleServerToggle = (id: string, on: boolean) => {
    setServerAvailablePlugin(id, on);
    setAvailable(prev => (on ? [...prev, id] : prev.filter(x => x !== id)));
  };

  const handleUserToggle = (id: string, on: boolean) => {
    setUserEnabledPlugin(id, on);
    setEnabled(prev => (on ? [...prev, id] : prev.filter(x => x !== id)));
  };

  const isAvailable = (id: string) => available.includes(id);
  const isEnabled = (id: string) => enabled.includes(id);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      {/* Header */}
      <div className="border-b border-border-subtle pb-4">
        <h1 className="text-xl font-bold text-txt-primary flex items-center gap-2">
          <Settings2 className="w-5 h-5 text-brand" />
          <span>Plugins</span>
        </h1>
        <p className="text-xs text-txt-secondary mt-1">
          Bundled with Nixre but inert until enabled. A plugin is live only when the instance has it available AND you turn it on.
        </p>
      </div>

      {/* How it works */}
      <div className="border border-border-subtle rounded-lg bg-surface-canvas p-5 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-txt-primary">
          <Info className="w-4 h-4 text-brand" />
          <span>Two-layer activation</span>
        </div>
        <ol className="text-xs text-txt-secondary space-y-1.5 list-decimal list-inside">
          <li><span className="text-txt-primary">Server gate</span> — the operator enables a plugin for the instance. If off, it never appears.</li>
          <li><span className="text-txt-primary">User toggle</span> — you turn it on. Every plugin is disabled by default.</li>
        </ol>
      </div>

      {/* Operator controls: server availability */}
      <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-txt-primary uppercase tracking-wider flex items-center gap-2">
            <Shield className="w-4 h-4 text-brand" />
            <span>Server availability</span>
          </h2>
          <p className="text-xs text-txt-secondary mt-0.5">
            Simulates the operator-side gate. Toggle which bundled plugins the instance serves.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {PLUGINS.map(plugin => (
            <div key={plugin.id} className="flex items-center justify-between p-3 rounded bg-surface-base border border-border-subtle">
              <div className="flex items-center gap-2 min-w-0">
                <plugin.icon className="w-4 h-4 shrink-0 text-txt-tertiary" />
                <span className="text-xs font-medium text-txt-primary truncate">{plugin.name}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isAvailable(plugin.id)}
                aria-label={`Server availability: ${plugin.name}`}
                title={`Enable ${plugin.name} at the instance level`}
                onClick={() => handleServerToggle(plugin.id, !isAvailable(plugin.id))}
                className={`relative inline-flex h-5 w-10 shrink-0 items-center rounded border transition ${
                  isAvailable(plugin.id) ? 'border-brand bg-brand' : 'border-border-mid bg-surface-subtle'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                    isAvailable(plugin.id) ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Configure drawer */}
      {configuredPlugin && (
        <div className="border border-brand/40 rounded-lg bg-surface-canvas p-6">
          {isAssistantPlugin(configuredPlugin) ? (
            <AssistantProfileForm mode="provider" onClose={() => setConfiguringId(null)} />
          ) : (
            <PluginConfigForm
              title={`${configuredPlugin.name} settings`}
              fields={configuredPlugin.profileFields ?? []}
              initial={getPluginConfig(configuredPlugin.id)}
              onSubmit={values => {
                setPluginConfig(configuredPlugin.id, values);
                setConfiguringId(null);
              }}
              onSubmitLabel="Save settings"
            />
          )}
        </div>
      )}

      {/* Plugins */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {PLUGINS.map(plugin => (
          <PluginToggle
            key={plugin.id}
            plugin={plugin}
            available={isAvailable(plugin.id)}
            enabled={isEnabled(plugin.id)}
            onToggle={on => handleUserToggle(plugin.id, on)}
            onConfigure={() => setConfiguringId(plugin.id)}
          />
        ))}
      </div>

      {/* Footer note */}
      <p className="text-[11px] text-txt-tertiary text-center">
        {PLUGINS.length} plugins bundled. Changes are stored locally in this browser; real enforcement happens on the server.
      </p>
    </div>
  );
};
