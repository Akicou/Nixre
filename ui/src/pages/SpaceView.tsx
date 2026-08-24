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

export const SpaceView: React.FC = () => {
  const { space: spaceUid } = useParams<{ space: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') === 'repositories' ? 'repositories' : 'overview';

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
          api.listSpaceMembers(spaceUid).then(setMembers).catch(() => setMembers([]));
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
  const canEditAvatar = isPersonal ? Boolean(profile?.is_self) : Boolean(space.is_member);
  const years = contributionYears((isPersonal ? profile?.created : space.created) || space.created);
  const overviewRepos = repos.slice(0, 6);

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

  const setTab = (tab: 'overview' | 'repositories') => {
    if (tab === 'overview') setSearchParams({});
    else setSearchParams({ tab: 'repositories' });
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
              <h2 className="text-xs font-semibold text-txt-primary mb-2">People</h2>
              <div className="flex flex-wrap gap-1.5">
                {members.map(m => (
                  <Link key={m.uid} to={`/${m.uid}`} title={m.display_name || m.uid}>
                    <Avatar name={m.uid} url={m.avatar_url} size={32} />
                  </Link>
                ))}
              </div>
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
        </div>
      </div>
    </div>
  );
};
