import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Bot, Plug } from 'lucide-react';
import { api, Repository } from '../lib/api';
import { isPluginLive } from '../lib/pluginPreferences';
import { getActiveProviderProfile, type AssistantProviderProfile } from '../lib/assistantProfiles';
import { ChatSurface } from '../components/assistant/ChatSurface';

export const AssistantPage: React.FC = () => {
  const { space, repo } = useParams<{ space: string; repo: string }>();
  const navigate = useNavigate();
  const repoPath = `${space}/${repo}`;
  const [repoInfo, setRepoInfo] = useState<Repository | null>(null);
  const [profile, setProfile] = useState<AssistantProviderProfile | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    Promise.all([api.getRepo(repoPath).catch(() => null), isPluginLive('nixre-assistant'), getActiveProviderProfile()])
      .then(([info, isLive, activeProfile]) => {
        if (cancelled) return;
        setRepoInfo(info);
        setLive(isLive);
        setProfile(activeProfile);
      })
      .catch(() => {
        if (!cancelled) setLive(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  if (loading) {
    return <div className="py-16 text-center text-sm text-txt-tertiary">Loading assistant…</div>;
  }

  if (!live) {
    return (
      <div className="max-w-xl mx-auto px-6 py-16 text-center">
        <div className="mx-auto w-14 h-14 rounded-xl bg-surface-subtle border border-border-subtle flex items-center justify-center mb-4">
          <Plug className="w-7 h-7 text-txt-tertiary" />
        </div>
        <h1 className="text-lg font-semibold text-txt-primary mb-2">Nixre Assistant is off</h1>
        <p className="text-sm text-txt-secondary mb-6">
          The assistant plugin is not enabled for this instance. Turn it on in the plugins page to chat with the copilot in{' '}
          <span className="font-mono">{repoPath}</span>.
        </p>
        <Link
          to="/plugins"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand text-white text-sm font-medium hover:bg-brand-hover transition shadow-sm"
        >
          <Bot className="w-4 h-4" />
          Open Plugins
        </Link>
      </div>
    );
  }

  // The app shell adds a 57px sticky navbar (h-14 + border) and ~48px footer;
  // the chat needs a bounded height so its internal flex/scroll layout works.
  return (
    <div className="flex flex-col h-[calc(100dvh-7rem)] min-h-[28rem]">
      <div className="flex flex-wrap items-center justify-end gap-2 px-3 sm:px-4 py-2 border-b border-border-subtle bg-surface-canvas shrink-0">
        <button
          onClick={() => navigate(`/agent?repo=${encodeURIComponent(repoPath)}`)}
          title="Hand this task to the agentic engineering workspace"
          className="flex items-center gap-1.5 text-xs px-3 py-2.5 rounded-md border border-border-subtle bg-surface-base text-txt-secondary hover:text-txt-primary hover:border-brand transition min-h-11"
        >
          Open in Agent Workspace
        </button>
      </div>
      <div className="relative flex-1 min-h-0">
        {profile && (
          <ChatSurface
            repoPath={repoPath}
            profile={profile}
            title={repoInfo?.description || repoPath}
            suggestions={['Review this change for regressions', 'Run the tests and lint', 'Scan for exposed secrets', 'Explain what this repo does']}
          />
        )}
      </div>
    </div>
  );
};
