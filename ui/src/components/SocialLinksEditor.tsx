import React from 'react';
import { Link2, Plus, Trash2 } from 'lucide-react';
import { SocialLink } from '../lib/api';

// The same editor for a user profile and an organization — both store
// { platform, url } pairs and both save through a form that already exists.
export const SocialLinksEditor: React.FC<{
  links: SocialLink[];
  onChange: (next: SocialLink[]) => void;
  hint?: string;
}> = ({ links, onChange, hint }) => (
  <div>
    <span className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
      Social Links
    </span>
    <p className="text-[11px] text-txt-tertiary mb-2">
      {hint ?? 'Add links to show on the public profile — e.g. GitHub, X/Twitter, LinkedIn, or a site.'}
    </p>
    <div className="space-y-2">
      {links.map((s, i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="relative flex-1">
            <Link2 className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-txt-tertiary" />
            <input
              type="text"
              placeholder="platform (optional)"
              value={s.platform}
              onChange={e => onChange(links.map((s2, idx) => (idx === i ? { ...s2, platform: e.target.value } : s2)))}
              className="w-full pl-8 pr-2 py-1.5 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
            />
          </div>
          <input
            type="text"
            placeholder="github.com/you"
            value={s.url}
            onChange={e => onChange(links.map((s2, idx) => (idx === i ? { ...s2, url: e.target.value } : s2)))}
            className="flex-1 px-2 py-1.5 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
          />
          <button
            type="button"
            onClick={() => onChange(links.filter((_, idx) => idx !== i))}
            className="p-1.5 rounded hover:bg-feedback-error-bg text-txt-tertiary hover:text-feedback-error-text transition"
            title="Remove link"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      {links.length === 0 && <p className="text-[11px] text-txt-tertiary">No social links yet.</p>}
    </div>
    <button
      type="button"
      onClick={() => onChange([...links, { platform: '', url: '' }])}
      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-surface-base border border-border-subtle text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
    >
      <Plus className="w-3.5 h-3.5" />
      <span>Add social link</span>
    </button>
  </div>
);

// The server drops a link it cannot turn into an http(s) URL. Saying so beats
// "Saved." over a row that silently disappeared from the form.
export function savedSocialsMessage(sent: SocialLink[], saved: SocialLink[] | undefined, noun: string): string {
  const ignored = sent.length - (saved?.length ?? 0);
  return ignored > 0
    ? `${noun} saved. ${ignored} social ${ignored === 1 ? 'link was' : 'links were'} ignored — each needs a usable web address.`
    : `${noun} saved.`;
}
