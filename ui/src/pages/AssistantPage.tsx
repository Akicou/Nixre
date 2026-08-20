import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Bot, Plug } from 'lucide-react';
import { api, Repository } from '../lib/api';
import { isPluginLive } from '../lib/pluginPreferences';
import { getActiveProviderProfile } from '../lib/assistantProfiles';
import { ChatSurface } from '../components/assistant/ChatSurface';

export const AssistantPage: React.FC = () => {
  const { space, repo } = useParams<{ space: string; repo: string }>();
  const repoPath = `${space}/${repo}`;
  const [repoInfo, setRepoInfo] = useState<Repository | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!repoPath) return;
    api
      .getRepo(repoPath)
      .then(setRepoInfo)
      .catch(() => setRepoInfo(null))
      .finally(() => setLoading(false));
  }, [repoPath]);

  const live = isPluginLive('nixre-assistant');

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

  return (
    <ChatSurface
      repoPath={repoPath}
      profile={getActiveProviderProfile()}
      title={repoInfo?.description || repoPath}
      suggestions={['Review this change for regressions', 'Run the tests and lint', 'Scan for exposed secrets', 'Explain what this repo does']}
    />
  );
};
