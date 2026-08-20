import React, { useState } from 'react';
import { Check } from 'lucide-react';
import type { ProfileField } from '../lib/plugins';

interface PluginConfigFormProps {
  title: string;
  description?: string;
  fields: ProfileField[];
  // Pre-fill values (e.g. a saved profile). Missing keys fall back to defaults.
  initial?: Record<string, string | number | boolean>;
  onSubmit: (values: Record<string, string | number | boolean>) => void;
  onSubmitLabel?: string;
  submitting?: boolean;
}

const Toggle: React.FC<{ value: boolean; onChange: (v: boolean) => void }> = ({ value, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={value}
    onClick={() => onChange(!value)}
    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded border transition ${
      value ? 'border-brand bg-brand' : 'border-border-mid bg-surface-subtle'
    }`}
  >
    <span
      className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
        value ? 'translate-x-4' : 'translate-x-0.5'
      }`}
    />
  </button>
);

export const PluginConfigForm: React.FC<PluginConfigFormProps> = ({
  title,
  description,
  fields,
  initial,
  onSubmit,
  onSubmitLabel = 'Save',
  submitting = false,
}) => {
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => {
    const start: Record<string, string | number | boolean> = {};
    for (const f of fields) start[f.key] = f.default;
    if (initial) Object.assign(start, initial);
    return start;
  });

  const set = (key: string, next: string | number | boolean) =>
    setValues(prev => ({ ...prev, [key]: next }));

  return (
    <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-txt-primary uppercase tracking-wider">{title}</h2>
        {description && <p className="text-xs text-txt-secondary mt-0.5">{description}</p>}
      </div>

      <div className="space-y-4">
        {fields.map(field => (
          <div key={field.key} className="space-y-1.5">
            <label htmlFor={field.key} className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider">
              {field.label}
            </label>

            {field.type === 'toggle' ? (
              <div className="flex items-center gap-3">
                <Toggle value={Boolean(values[field.key])} onChange={v => set(field.key, v)} />
                {field.description && <span className="text-xs text-txt-tertiary">{field.description}</span>}
              </div>
            ) : field.type === 'textarea' ? (
              <textarea
                id={field.key}
                rows={3}
                placeholder={field.placeholder}
                value={String(values[field.key] ?? '')}
                onChange={e => set(field.key, e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
              />
            ) : field.type === 'select' ? (
              // Provider-scoped selects (e.g. the assistant model picker) show
              // only the options for the currently-selected provider.
              field.modelsByProvider ? (
                <select
                  id={field.key}
                  value={String(values[field.key] ?? field.default)}
                  onChange={e => set(field.key, e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs focus:border-brand transition"
                >
                  {(field.modelsByProvider[String(values.provider) ?? ''] ?? []).map(o => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <select
                  id={field.key}
                  value={String(values[field.key] ?? field.default)}
                  onChange={e => set(field.key, e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs focus:border-brand transition"
                >
                  {(field.options ?? []).map(o => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              )
            ) : field.type === 'secret' ? (
              <input
                id={field.key}
                type="password"
                placeholder={field.placeholder}
                value={String(values[field.key] ?? '')}
                onChange={e => set(field.key, e.target.value)}
                autoComplete="off"
                className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
              />
            ) : (
              <input
                id={field.key}
                type={field.type === 'number' ? 'number' : 'text'}
                min={field.min}
                max={field.max}
                step={field.step}
                placeholder={field.placeholder}
                value={String(values[field.key] ?? field.default)}
                onChange={e => {
                  const raw = e.target.value;
                  set(field.key, field.type === 'number' ? Number(raw) : raw);
                }}
                className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs focus:border-brand transition"
              />
            )}

            {field.type !== 'toggle' && field.description && (
              <p className="text-[11px] text-txt-tertiary">{field.description}</p>
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-end pt-2">
        <button
          type="button"
          disabled={submitting}
          onClick={() => onSubmit(values)}
          className="px-4 py-2 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition shadow-sm flex items-center gap-1.5"
        >
          <Check className="w-4 h-4" />
          <span>{submitting ? 'Saving...' : onSubmitLabel}</span>
        </button>
      </div>
    </div>
  );
};
