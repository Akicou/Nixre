import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import {
  FolderGit2,
  Plus,
  ArrowLeft,
  ImagePlus,
  X,
  AtSign,
  GitBranch,
  Globe,
  Link2,
  FileText,
  GitPullRequest,
  Pencil,
  UserPlus,
  ArrowRightLeft,
} from 'lucide-react';
import {
  api,
  Space,
  Repository,
  UserProfile,
  SocialLink,
  SpaceMember,
  Contributions,
  ProfileReadme,
} from '../lib/api';
import { Avatar } from '../components/Avatar';
import { ProfileGoals } from '../components/ProfileGoals';
import { ContributionGraph, contributionYears } from '../components/ContributionGraph';
import { SpaceDeployments } from '../components/SpaceDeployments';

const Markdown = React.lazy(() => import('../components/Markdown').then(m => ({ default: m.Markdown })));

const SOCIAL_ICONS: Record<string, React.FC<{ className?: string }>> = {
  github: GitBranch,
  gitlab: GitBranch,
  twitter: AtSign,
  x: AtSign,
  mastodon: AtSign,
  bluesky: AtSign,
  linkedin: Globe,
  website: Globe,
  blog: Globe,
  site: Globe,
};

function socialLabel(link: SocialLink): string {
  try {
    const host = new URL(link.url).host.replace(/^www\./, '');
    return host || link.url;
  } catch {
    return link.url;
  }
}

const SocialRow: React.FC<{ link: SocialLink }> = ({ link }) => {
  const Icon = SOCIAL_ICONS[link.platform.toLowerCase()] ?? Link2;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 text-xs text-txt-secondary hover:text-txt-brand transition min-w-0"
      title={link.url}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{socialLabel(link)}</span>
    </a>
  );
};

type OrgTab = 'overview' | 'repositories' | 'deployments' | 'people' | 'settings';

function tabFromSearch(raw: string | null, opts: { isPersonal: boolean; canManage: boolean }): OrgTab {
  if (raw === 'repositories') return 'repositories';
  if (raw === 'deployments') return 'deployments';
  if (!opts.isPersonal && raw === 'people') return 'people';
  if (!opts.isPersonal && opts.canManage && raw === 'settings') return 'settings';
  return 'overview';
}

function roleLabel(role: string): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  return 'Member';
}

const RoleBadge: React.FC<{ role: string }> = ({ role }) => (
  <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary shrink-0">
    {roleLabel(role)}
  </span>
);

function canChangeMemberRole(space: Space, target: SpaceMember): boolean {
  if (!space.can_manage || target.role === 'owner') return false;
  if (space.role === 'admin' && target.role !== 'member') return false;
  return true;
}

function canRemoveMember(space: Space, target: SpaceMember, ownerCount: number): boolean {
  if (!space.can_manage) return false;
  if (target.role === 'owner') {
    if (ownerCount <= 1) return false;
    return space.role === 'owner' || space.role == null;
  }
  if (space.role === 'admin' && target.role !== 'member') return false;
  return true;
}

const RepoCard: React.FC<{ repo: Repository }> = ({ repo }) => (
  <div className="border border-border-subtle rounded-lg bg-surface-canvas p-4 flex flex-col gap-2 min-w-0 hover:bg-surface-subtle/40 transition">
    <div className="flex items-start justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <FolderGit2 className="w-4 h-4 text-txt-tertiary shrink-0" />
        <Link to={`/${repo.path}`} className="font-mono text-sm font-semibold text-txt-brand hover:underline truncate">
          {repo.uid}
        </Link>
      </div>
      <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded-full border border-border-subtle text-txt-tertiary shrink-0">
        {repo.is_public ? 'Public' : 'Private'}
      </span>
    </div>
    {repo.description && (
      <p className="text-xs text-txt-secondary line-clamp-2">{repo.description}</p>
    )}
    <div className="mt-auto flex items-center gap-3 text-[11px] text-txt-tertiary pt-1">
      {repo.num_open_pulls > 0 && (
        <span className="inline-flex items-center gap-1">
          <GitPullRequest className="w-3.5 h-3.5" />
          {repo.num_open_pulls}
        </span>
      )}
    </div>
  </div>
);

const OrgPeoplePanel: React.FC<{
  space: Space;
  members: SpaceMember[];
  onMembers: (next: SpaceMember[]) => void;
  onSpace: (next: Space) => void;
}> = ({ space, members, onMembers, onSpace }) => {
  const [inviteUid, setInviteUid] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [transferUid, setTransferUid] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const ownerCount = members.filter(m => m.role === 'owner').length;
  const inviteRoles: Array<'member' | 'admin'> = space.role === 'admin' ? ['member'] : ['member', 'admin'];

  const run = async (fn: () => Promise<void>) => {
    setErr('');
    setMsg('');
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message || 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {err && (
        <div className="p-3 rounded bg-feedback-error-bg border border-feedback-error-border text-feedback-error-text text-xs">
          {err}
        </div>
      )}
      {msg && (
        <div className="p-3 rounded bg-feedback-success-bg border border-feedback-success-border text-feedback-success-text text-xs">
          {msg}
        </div>
      )}

      {space.can_manage && (
        <form
          className="border border-border-subtle rounded-lg bg-surface-canvas p-4 space-y-3"
          onSubmit={e => {
            e.preventDefault();
            const uid = inviteUid.trim();
            if (!uid) return;
            run(async () => {
              onMembers(await api.addSpaceMember(space.uid, uid, inviteRole));
              setInviteUid('');
              setMsg(`Added ${uid} as ${roleLabel(inviteRole).toLowerCase()}.`);
            });
          }}
        >
          <h3 className="text-sm font-semibold text-txt-primary inline-flex items-center gap-1.5">
            <UserPlus className="w-4 h-4 text-txt-tertiary" />
            Add member
          </h3>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={inviteUid}
              onChange={e => setInviteUid(e.target.value)}
              placeholder="username"
              className="flex-1 px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm font-mono focus:border-brand transition"
              required
            />
            <select
              value={inviteRole}
              onChange={e => setInviteRole(e.target.value as 'member' | 'admin')}
              className="px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm"
            >
              {inviteRoles.map(r => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-2 rounded-md text-xs font-medium bg-brand text-white hover:bg-brand-hover transition shadow-sm disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </form>
      )}

      <div className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden">
        <div className="px-4 py-2 bg-surface-base border-b border-border-subtle text-xs font-semibold text-txt-primary">
          {members.length} {members.length === 1 ? 'person' : 'people'}
        </div>
        {members.length === 0 ? (
          <p className="px-4 py-8 text-sm text-txt-secondary text-center">No members to show.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {members.map(m => (
              <li key={m.uid} className="px-4 py-3 flex items-center gap-3 min-w-0">
                <Link to={`/${m.uid}`} className="flex items-center gap-3 min-w-0 flex-1">
                  <Avatar name={m.uid} url={m.avatar_url} size={36} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-txt-primary truncate">{m.display_name || m.uid}</p>
                    <p className="text-xs text-txt-tertiary font-mono truncate">{m.uid}</p>
                  </div>
                </Link>
                <div className="flex items-center gap-2 shrink-0">
                  {canChangeMemberRole(space, m) ? (
                    <select
                      aria-label={`Role for ${m.uid}`}
                      value={m.role}
                      disabled={busy}
                      onChange={e => {
                        const next = e.target.value as 'admin' | 'member';
                        run(async () => {
                          onMembers(await api.updateSpaceMember(space.uid, m.uid, next));
                        });
                      }}
                      className="px-2 py-1 rounded-md bg-surface-base border border-border-subtle text-xs text-txt-primary"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  ) : (
                    <RoleBadge role={m.role} />
                  )}
                  {canRemoveMember(space, m, ownerCount) && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Remove ${m.uid} from ${space.uid}?`)) return;
                        run(async () => {
                          onMembers(await api.removeSpaceMember(space.uid, m.uid));
                        });
                      }}
                      className="text-xs text-txt-secondary hover:text-feedback-error-text transition disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {space.can_transfer && (
        <form
          className="border border-border-subtle rounded-lg bg-surface-canvas p-4 space-y-3"
          onSubmit={e => {
            e.preventDefault();
            const uid = transferUid.trim();
            if (!uid) return;
            const demote = space.role === 'owner'
              ? ` You will become an admin.`
              : '';
            if (!window.confirm(`Transfer ownership of ${space.uid} to ${uid}?${demote}`)) return;
            run(async () => {
              const result = await api.transferSpace(space.uid, uid);
              onSpace(result.space);
              onMembers(result.members);
              setTransferUid('');
              setMsg(`Ownership transferred to ${uid}.`);
            });
          }}
        >
          <h3 className="text-sm font-semibold text-txt-primary inline-flex items-center gap-1.5">
            <ArrowRightLeft className="w-4 h-4 text-txt-tertiary" />
            Transfer ownership
          </h3>
          <p className="text-xs text-txt-secondary">
            The new owner must already have a Nixre account. {space.role === 'owner' ? 'You will be kept as an admin.' : ''}
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={transferUid}
              onChange={e => setTransferUid(e.target.value)}
              placeholder="new owner username"
              className="flex-1 px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm font-mono focus:border-brand transition"
              required
            />
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-2 rounded-md text-xs font-medium bg-surface-subtle border border-border-subtle text-txt-primary hover:bg-surface-mid transition disabled:opacity-50"
            >
              Transfer
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

const OrgSettingsPanel: React.FC<{
  space: Space;
  onSpace: (next: Space) => void;
}> = ({ space, onSpace }) => {
  const [description, setDescription] = useState(space.description || '');
  const [isPublic, setIsPublic] = useState(Boolean(space.is_public));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setDescription(space.description || '');
    setIsPublic(Boolean(space.is_public));
  }, [space.uid, space.description, space.is_public]);

  return (
    <form
      className="border border-border-subtle rounded-lg bg-surface-canvas p-4 sm:p-6 space-y-4 max-w-xl"
      onSubmit={async e => {
        e.preventDefault();
        setErr('');
        setMsg('');
        setSaving(true);
        try {
          const next = await api.updateSpace(space.uid, { description, is_public: isPublic });
          onSpace(next);
          setMsg('Organization saved.');
        } catch (e: any) {
          setErr(e.message || 'Failed to save organization.');
        } finally {
          setSaving(false);
        }
      }}
    >
      <h2 className="text-sm font-semibold text-txt-primary">Organization settings</h2>
      {err && (
        <div className="p-3 rounded bg-feedback-error-bg border border-feedback-error-border text-feedback-error-text text-xs">
          {err}
        </div>
      )}
      {msg && (
        <div className="p-3 rounded bg-feedback-success-bg border border-feedback-success-border text-feedback-success-text text-xs">
          {msg}
        </div>
      )}
      <div>
        <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
          Description
        </label>
        <textarea
          rows={3}
          value={description}
          onChange={e => setDescription(e.target.value)}
          className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm focus:border-brand transition"
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-txt-primary">
        <input type="checkbox" checked={isPublic} onChange={e => setIsPublic(e.target.checked)} />
        Public organization
      </label>
      <p className="text-xs text-txt-tertiary">The organization name cannot be changed.</p>
      <button
        type="submit"
        disabled={saving}
        className="px-3 py-1.5 rounded-md text-xs font-medium bg-brand text-white hover:bg-brand-hover transition shadow-sm disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
};

export const SpaceView: React.FC = () => {
  const { space: spaceUid } = useParams<{ space: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [space, setSpace] = useState<Space | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [readmeContent, setReadmeContent] = useState<string | null>(null);
  const [contrib, setContrib] = useState<Contributions | null>(null);
  const [contribYear, setContribYear] = useState(() => new Date().getUTCFullYear());
  const [contribLoading, setContribLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!spaceUid) return;
    setLoading(true);
    setError('');
    setProfile(null);
    setReadmeContent(null);
    setMembers([]);
    api.getSpace(spaceUid)
      .then(async s => {
        setSpace(s);
        if (s.is_personal) {
          try {
            const p = await api.getUserProfile(spaceUid);
            setProfile(p);
          } catch {
            /* profile is best-effort; the space still renders */
          }
        } else {
          const m = await api.listSpaceMembers(spaceUid).catch(() => []);
          setMembers(Array.isArray(m) ? m : []);
        }
        const r = await api.listRepos(spaceUid).catch(() => []);
        setRepos(Array.isArray(r) ? r : []);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Space not found');
        setLoading(false);
      });
  }, [spaceUid]);

  useEffect(() => {
    load();
  }, [load]);

  const isPersonal = Boolean(space?.is_personal);
  const readmeMeta: ProfileReadme | undefined = profile?.profile_readme || space?.profile_readme;

  useEffect(() => {
    if (!readmeMeta?.hasReadme || !readmeMeta.repo) {
      setReadmeContent(null);
      return;
    }
    let cancelled = false;
    api.getRawBlob(readmeMeta.repo.path, readmeMeta.repo.default_branch, readmeMeta.repo.readme)
      .then(blob => { if (!cancelled) setReadmeContent(blob.content); })
      .catch(() => { if (!cancelled) setReadmeContent(null); });
    return () => { cancelled = true; };
  }, [readmeMeta?.hasReadme, readmeMeta?.repo?.path, readmeMeta?.repo?.default_branch, readmeMeta?.repo?.readme]);

  useEffect(() => {
    if (!spaceUid || !space) return;
    let cancelled = false;
    setContribLoading(true);
    api.getContributions(isPersonal ? 'user' : 'space', spaceUid, contribYear)
      .then(c => { if (!cancelled) setContrib(c); })
      .catch(() => { if (!cancelled) setContrib({ year: contribYear, total: 0, days: [] }); })
      .finally(() => { if (!cancelled) setContribLoading(false); });
    return () => { cancelled = true; };
  }, [spaceUid, space, isPersonal, contribYear]);

  if (loading) {
    return <div className="max-w-7xl mx-auto px-4 py-16 text-center text-sm text-txt-tertiary">Loading...</div>;
  }

  if (error || !space) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center space-y-4">
        <h2 className="text-lg font-bold text-txt-primary">Space not found</h2>
        <p className="text-sm text-txt-secondary">{error || 'The requested space does not exist.'}</p>
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-txt-brand hover:underline">
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Dashboard</span>
        </Link>
      </div>
    );
  }

  const canCreate = isPersonal ? Boolean(profile?.is_self) : Boolean(space.is_member);
  const avatarUrl = (isPersonal ? profile?.avatar_url : space.avatar_url) || '';
  const displayName = isPersonal ? (profile?.display_name || space.uid) : space.uid;
  const avatarName = isPersonal ? profile?.uid || space.uid : space.uid;
  const bio = isPersonal ? profile?.bio : space.description;
  const canEditAvatar = isPersonal ? Boolean(profile?.is_self) : Boolean(space.can_manage);
  const years = contributionYears((isPersonal ? profile?.created : space.created) || space.created);
  const overviewRepos = repos.slice(0, 6);
  const activeTab = tabFromSearch(searchParams.get('tab'), {
    isPersonal,
    canManage: Boolean(space.can_manage),
  });

  const handleFile = async (file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.split(',')[1] || '';
      const mime = file.type;
      try {
        if (isPersonal) {
          await api.setUserAvatar(base64, mime);
          if (profile) setProfile({ ...profile, avatar_url: `/api/v1/avatars/user/${spaceUid}?v=${Date.now()}` });
        } else {
          await api.setSpaceAvatar(spaceUid!, base64, mime);
          setSpace({ ...space, avatar_url: `/api/v1/avatars/space/${spaceUid}?v=${Date.now()}` });
        }
      } catch {
        /* ignored — the change simply won't reflect */
      }
    };
    reader.readAsDataURL(file);
  };

  const handleRemove = async () => {
    try {
      if (isPersonal) {
        await api.removeUserAvatar();
        if (profile) setProfile({ ...profile, avatar_url: '' });
      } else {
        await api.removeSpaceAvatar(spaceUid!);
        setSpace({ ...space, avatar_url: '' });
      }
    } catch {
      /* ignored */
    }
  };

  const setTab = (tab: OrgTab) => {
    if (tab === 'overview') setSearchParams({});
    else setSearchParams({ tab });
  };

  const emptyRepos = (
    <div className="border border-dashed border-border-subtle rounded-lg p-10 text-center bg-surface-canvas/50">
      <p className="text-sm text-txt-secondary">No repositories yet.</p>
      {canCreate && (
        <Link
          to="/new-repo"
          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover transition shadow-sm"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Create first repository</span>
        </Link>
      )}
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 w-full min-w-0">
      <nav className="border-b border-border-subtle flex items-end gap-1 -mb-px overflow-x-auto">
        <button
          type="button"
          onClick={() => setTab('overview')}
          className={`px-4 py-3 text-sm font-medium border-b-2 transition shrink-0 ${
            activeTab === 'overview'
              ? 'border-brand text-txt-primary'
              : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          Overview
        </button>
        <button
          type="button"
          onClick={() => setTab('repositories')}
          className={`px-4 py-3 text-sm font-medium border-b-2 transition shrink-0 inline-flex items-center gap-2 ${
            activeTab === 'repositories'
              ? 'border-brand text-txt-primary'
              : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          Repositories
          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded-full bg-surface-subtle text-txt-tertiary">
            {repos.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setTab('deployments')}
          data-testid="space-tab-deployments"
          className={`px-4 py-3 text-sm font-medium border-b-2 transition shrink-0 inline-flex items-center gap-2 ${
            activeTab === 'deployments'
              ? 'border-brand text-txt-primary'
              : 'border-transparent text-txt-secondary hover:text-txt-primary'
          }`}
        >
          Deployments
        </button>
        {!isPersonal && (
          <button
            type="button"
            onClick={() => setTab('people')}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition shrink-0 inline-flex items-center gap-2 ${
              activeTab === 'people'
                ? 'border-brand text-txt-primary'
                : 'border-transparent text-txt-secondary hover:text-txt-primary'
            }`}
          >
            People
            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded-full bg-surface-subtle text-txt-tertiary">
              {members.length}
            </span>
          </button>
        )}
        {!isPersonal && space.can_manage && (
          <button
            type="button"
            onClick={() => setTab('settings')}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition shrink-0 inline-flex items-center gap-2 ${
              activeTab === 'settings'
                ? 'border-brand text-txt-primary'
                : 'border-transparent text-txt-secondary hover:text-txt-primary'
            }`}
          >
            Settings
          </button>
        )}
      </nav>

      <div className="py-6 grid grid-cols-1 lg:grid-cols-[296px_minmax(0,1fr)] gap-8">
        <aside className="min-w-0 space-y-4">
          <div className="relative w-20 h-20 lg:w-[296px] lg:h-[296px]">
            <Avatar
              name={avatarName}
              url={avatarUrl}
              fill
              shape={isPersonal ? 'circle' : 'square'}
            />
            {canEditAvatar && (
              <div className="absolute bottom-1 right-1 flex gap-0.5">
                <label className="p-1.5 rounded-full bg-surface-canvas border border-border-subtle text-txt-secondary hover:text-txt-primary transition cursor-pointer" title="Upload avatar">
                  <ImagePlus className="w-3.5 h-3.5" />
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                </label>
                {avatarUrl && (
                  <button onClick={handleRemove} className="p-1.5 rounded-full bg-surface-canvas border border-border-subtle text-txt-secondary hover:text-feedback-error-text transition" title="Remove avatar">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-bold text-txt-primary leading-tight break-words">{displayName}</h1>
            {isPersonal && (
              <p className="text-lg text-txt-tertiary leading-tight">{space.uid}</p>
            )}
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary">
                {space.is_public ? 'Public' : 'Private'}
              </span>
              {!isPersonal && (
                <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary">
                  Organization
                </span>
              )}
              {!isPersonal && space.role && (
                <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary">
                  {roleLabel(space.role)}
                </span>
              )}
            </div>
          </div>

          {bio && <p className="text-sm text-txt-primary whitespace-pre-wrap">{bio}</p>}

          {isPersonal && profile?.is_self && (
            <Link
              to="/settings"
              className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-md text-sm font-medium bg-surface-subtle border border-border-subtle text-txt-primary hover:bg-surface-mid transition"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit profile
            </Link>
          )}

          {!isPersonal && space.can_manage && (
            <button
              type="button"
              onClick={() => setTab('settings')}
              className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-md text-sm font-medium bg-surface-subtle border border-border-subtle text-txt-primary hover:bg-surface-mid transition"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit organization
            </button>
          )}

          {(profile?.socials?.length ?? 0) > 0 && (
            <div className="space-y-1.5 pt-1">
              {profile!.socials!.map(s => (
                <SocialRow key={`${s.platform}-${s.url}`} link={s} />
              ))}
            </div>
          )}

          {isPersonal && (profile?.orgs?.length ?? 0) > 0 && (
            <div className="pt-2">
              <h2 className="text-xs font-semibold text-txt-primary mb-2">Organizations</h2>
              <div className="flex flex-wrap gap-1.5">
                {profile!.orgs!.map(org => (
                  <Link key={org.uid} to={`/${org.uid}`} title={org.uid}>
                    <Avatar name={org.uid} url={org.avatar_url} size={32} shape="square" />
                  </Link>
                ))}
              </div>
            </div>
          )}

          {!isPersonal && members.length > 0 && (
            <div className="pt-2">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-semibold text-txt-primary">People</h2>
                <button
                  type="button"
                  onClick={() => setTab('people')}
                  className="text-[11px] text-txt-brand hover:underline"
                >
                  {members.length}
                </button>
              </div>
              <ul className="space-y-2">
                {members.slice(0, 8).map(m => (
                  <li key={m.uid}>
                    <Link to={`/${m.uid}`} className="flex items-center gap-2 min-w-0">
                      <Avatar name={m.uid} url={m.avatar_url} size={28} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-txt-primary truncate">{m.display_name || m.uid}</p>
                        <p className="text-[11px] text-txt-tertiary font-mono truncate">{m.uid}</p>
                      </div>
                      <RoleBadge role={m.role} />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <div className="min-w-0 space-y-6">
          {activeTab === 'overview' && (
            <>
              {readmeContent && (
                <div className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden">
                  <div className="px-4 py-2 bg-surface-base border-b border-border-subtle flex items-center gap-2 text-xs font-mono font-semibold text-txt-primary">
                    <FileText className="w-4 h-4 text-txt-tertiary" />
                    <span>{space.uid} / {readmeMeta?.repo?.readme || 'README.md'}</span>
                  </div>
                  <div className="p-6">
                    <React.Suspense fallback={<p className="text-xs text-txt-tertiary">Loading README…</p>}>
                      <Markdown content={readmeContent} />
                    </React.Suspense>
                  </div>
                </div>
              )}

              {isPersonal && profile?.is_self && (
                <ProfileGoals uid={space.uid} onChanged={load} />
              )}

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-txt-primary">Repositories</h2>
                  {repos.length > 6 && (
                    <button
                      type="button"
                      onClick={() => setTab('repositories')}
                      className="text-xs text-txt-brand hover:underline"
                    >
                      View all
                    </button>
                  )}
                </div>
                {repos.length === 0 ? emptyRepos : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {overviewRepos.map(r => <RepoCard key={r.id} repo={r} />)}
                  </div>
                )}
              </div>

              <ContributionGraph
                data={contrib}
                years={years}
                onYearChange={setContribYear}
                loading={contribLoading}
              />
            </>
          )}

          {activeTab === 'repositories' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-txt-primary">Repositories</h2>
                {canCreate && (
                  <Link
                    to="/new-repo"
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-brand text-white hover:bg-brand-hover transition shadow-sm inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    New repository
                  </Link>
                )}
              </div>
              {repos.length === 0 ? emptyRepos : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {repos.map(r => <RepoCard key={r.id} repo={r} />)}
                </div>
              )}
            </div>
          )}

          {activeTab === 'deployments' && <SpaceDeployments spaceUid={space.uid} />}

          {activeTab === 'people' && (
            <OrgPeoplePanel
              space={space}
              members={members}
              onMembers={setMembers}
              onSpace={setSpace}
            />
          )}

          {activeTab === 'settings' && space.can_manage && (
            <OrgSettingsPanel space={space} onSpace={setSpace} />
          )}
        </div>
      </div>
    </div>
  );
};
