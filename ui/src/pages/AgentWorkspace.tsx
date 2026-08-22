// Agentic engineering workspace — Nixre's answer to Cursor's agent view.
//
// Deliberately distinct from the in-repo assistant panel: this is where you
// hand the agent a goal ("plan a feature", "fix the failing tests") and let
// it work across a repo with tools. Repo pages keep their lightweight
// assistant; this page is the full agentic surface, reachable from anywhere
// via the ⚡Agent nav entry.
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bot, Plug } from 'lucide-react';
import { api } from '../lib/api';
import { isPluginLive } from '../lib/pluginPreferences';
import { getActiveProviderProfile, type AssistantProviderProfile } from '../lib/assistantProfiles';
import { ChatSurface } from '../components/assistant/ChatSurface';

export interface WorkspaceRepo {
  path: string;
  label: string;
}

const AGENT_SUGGESTIONS = [
  'Plan a new feature end-to-end',
  'Find and fix failing tests',
  'Refactor a module across files',
  'Audit this repo for bugs and dead code',
];

export const AgentWorkspace: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const repoParam = searchParams.get('repo') ?? '';

  const [profile, setProfile] = useState<AssistantProviderProfile | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [repos, setRepos] = useState<WorkspaceRepo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      isPluginLive('nixre-assistant'),
      getActiveProviderProfile(),
      api.listRepos().catch(() => []),
    ])
      .then(([isLive, activeProfile, repoList]) => {
        if (cancelled) return;
        setLive(isLive);
        setProfile(activeProfile);
        setRepos(
          repoList.map(r => ({
            path: r.path,
            label: r.path.split('/').pop() || r.path,
          })),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="py-16 text-center text-sm text-txt-tertiary">Loading workspace…</div>;
  }

  if (!live) {
    return (
      <div className="max-w-xl mx-auto px-6 py-16 text-center">
        <div className="mx-auto w-14 h-14 rounded-xl bg-surface-subtle border border-border-subtle flex items-center justify-center mb-4">
          <Plug className="w-7 h-7 text-txt-tertiary" />
        </div>
        <h1 className="text-lg font-semibold text-txt-primary mb-2">Nixre Assistant is off</h1>
        <p className="text-sm text-txt-secondary">
          Enable the assistant plugin to use the agentic engineering workspace.
        </p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="max-w-xl mx-auto px-6 py-16 text-center">
        <div className="mx-auto w-14 h-14 rounded-xl bg-surface-subtle border border-border-subtle flex items-center justify-center mb-4">
          <Bot className="w-7 h-7 text-txt-tertiary" />
        </div>
        <h1 className="text-lg font-semibold text-txt-primary mb-2">No AI provider configured</h1>
        <p className="text-sm text-txt-secondary">
          Add a provider under Plugins to start delegating engineering work.
        </p>
      </div>
    );
  }

  const activeRepo =
    repos.find(r => r.path === repoParam)?.path ?? repos[0]?.path ?? '';
  const changeRepo = (path: string) => setSearchParams(path ? { repo: path } : {});

  return (
    <div
      style={{ height: 'calc(100vh - 8.75rem)', minHeight: '32rem' }}
      className="flex flex-col"
    >
      <div className="flex-1 min-h-0">
        <ChatSurface
          key={activeRepo}
          variant="workspace"
          repoPath={activeRepo}
          profile={profile}
          title="Agent Workspace"
          suggestions={AGENT_SUGGESTIONS}
          repos={repos}
          onRepoChange={changeRepo}
        />
      </div>
    </div>
  );
};
