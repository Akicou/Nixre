import React from 'react';
import { Check } from 'lucide-react';
import type { Plugin } from '../lib/plugins';

export interface PluginToggleProps {
  plugin: Plugin;
  // Whether the server/instance has the plugin available (gate layer).
  available: boolean;
  // Whether this user has toggled the plugin on.
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  onConfigure?: () => void;
}

// A simple inline light-switch toggle so the whole page shares one look.
const Switch: React.FC<{ on: boolean; disabled: boolean; onChange: (on: boolean) => void }> = ({ on, disabled, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    disabled={disabled}
    onClick={() => !disabled && onChange(!on)}
    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded border transition ${
      disabled
        ? 'border-border-subtle bg-surface-mid cursor-not-allowed'
        : on
          ? 'border-brand bg-brand'
          : 'border-border-mid bg-surface-subtle'
    }`}
  >
    <span
      className={`inline-block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform ${
        on ? 'translate-x-4' : 'translate-x-0.5'
      } ${disabled ? 'opacity-60' : ''}`}
    />
  </button>
);

export const PluginToggle: React.FC<PluginToggleProps> = ({ plugin, available, enabled, onToggle, onConfigure }) => {
  const Icon = plugin.icon;
  // Driven by the parent's props (which mirror the localStorage layers) so the
  // card always reflects the current state, not a stale read.
  const live = available && enabled;
  const canConfigure = (plugin.hasForm || plugin.hasProfile) && available;

  let statusLabel: string;
  let statusClass: string;
  if (!available) {
    statusLabel = 'DISABLED';
    statusClass = 'bg-surface-mid text-txt-tertiary';
  } else if (live) {
    statusLabel = 'ACTIVE';
    statusClass = 'bg-surface-open text-txt-open';
  } else {
    statusLabel = 'OFF';
    statusClass = 'bg-surface-base text-txt-secondary border border-border-subtle';
  }

  return (
    <div
      className={`border rounded-lg bg-surface-canvas p-5 space-y-4 transition ${
        live ? 'border-brand/40' : 'border-border-subtle'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded bg-surface-subtle border border-border-subtle shrink-0 ${available ? 'text-txt-brand' : 'text-txt-tertiary opacity-60'}`}>
            <Icon className="w-5 h-5" />
          </div>
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-txt-primary">{plugin.name}</h3>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary">{plugin.category}</span>
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-bold ${statusClass}`}>
                {statusLabel}
              </span>
            </div>
            <p className="text-xs text-txt-secondary leading-relaxed">{plugin.description}</p>
          </div>
        </div>

        <Switch on={enabled} disabled={!available} onChange={onToggle} />
      </div>

      {plugin.tools && (
        <div className="flex flex-wrap gap-1.5">
          {plugin.tools.map(t => (
            <code key={t.name} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-base border border-border-subtle text-txt-secondary">
              {t.name}
            </code>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        {canConfigure && onConfigure && (
          <button
            type="button"
            onClick={onConfigure}
            className="px-3 py-1.5 rounded text-xs font-medium border border-border-subtle text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
          >
            Configure
          </button>
        )}
        {!available && (
          <span className="text-[11px] text-txt-tertiary">
            Enabled at the instance level only. Ask your operator to turn this plugin on.
          </span>
        )}
      </div>
    </div>
  );
};
