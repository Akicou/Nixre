import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { FolderGit2, Plus, ArrowRight, ArrowLeft, ImagePlus, X, AtSign, GitBranch, Globe, Link2, FileText } from 'lucide-react';
import { api, Space, Repository, UserProfile, SocialLink } from '../lib/api';
import { Avatar } from '../components/Avatar';
import { ProfileGoals } from '../components/ProfileGoals';

// Lazy so the org-space spec (which never renders a profile README) doesn't
// try to resolve react-markdown at module load.
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

const SocialLinkChip: React.FC<{ link: SocialLink }> = ({ link }) => {
  const Icon = SOCIAL_ICONS[link.platform.toLowerCase()] ?? Link2;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] bg-surface-subtle border border-border-subtle text-txt-secondary hover:text-txt-primary hover:border-border-mid transition"
      title={link.url}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span>{link.platform}</span>
    </a>
  );
};

export const SpaceView: React.FC = () => {
  const { space: spaceUid } = useParams<{ space: string }>();
  const [space, setSpace] = useState<Space | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [readmeContent, setReadmeContent] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!spaceUid) return;
    setLoading(true);
    setError('');
    setProfile(null);
    setReadmeContent(null);
    api.getSpace(spaceUid)
      .then(async s => {
        setSpace(s);
        if (s.is_personal) {
          try {
            const p = await api.getUserProfile(spaceUid);
            setProfile(p);
            // Fetch the profile README (if a profile repo with README exists).
            if (p.profile_readme?.hasReadme && p.profile_readme.repo) {
              try {
                const blob = await api.getRawBlob(
                  p.profile_readme.repo.path,
                  p.profile_readme.repo.default_branch,
                  p.profile_readme.repo.readme,
                );
                setReadmeContent(blob.content);
              } catch {
                setReadmeContent(null);
              }
            }
          } catch {
            /* profile is best-effort; the space still renders */
          }
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

  const isPersonal = Boolean(space.is_personal);
  const canCreate = isPersonal ? Boolean(profile?.is_self) : Boolean(space.is_member);
  // For a personal namespace we show the user's avatar; for an org, the space avatar.
  const avatarUrl = (isPersonal ? profile?.avatar_url : space.avatar_url) || '';
  const displayName = profile?.display_name || space.uid;
  const avatarName = isPersonal ? profile?.uid || space.uid : space.uid;

  const handleFile = async (file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || '');
      // strip the data-URL prefix; keep the raw base64
      const base64 = dataUrl.split(',')[1] || '';
      const mime = file.type;
      try {
        if (isPersonal) {
          await api.setUserAvatar(base64, mime);
          // best-effort refresh of the local profile avatar
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

  const canEditAvatar = isPersonal ? Boolean(profile?.is_self) : Boolean(space.is_member);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8 w-full min-w-0">
      {/* Header: GitHub-style user profile OR org space */}
      <div className="border-b border-border-subtle pb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <div className="relative shrink-0">
            <Avatar name={avatarName} url={avatarUrl} size={56} />
            {canEditAvatar && (
              <div className="absolute -bottom-1 -right-1 flex gap-0.5">
                <label className="p-1 rounded-full bg-surface-canvas border border-border-subtle text-txt-secondary hover:text-txt-primary transition cursor-pointer" title="Upload avatar">
                  <ImagePlus className="w-3.5 h-3.5" />
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                </label>
                {avatarUrl && (
                  <button onClick={handleRemove} className="p-1 rounded-full bg-surface-canvas border border-border-subtle text-txt-secondary hover:text-feedback-error-text transition" title="Remove avatar">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold font-mono text-txt-primary truncate">{space.uid}</h1>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary">
                {space.is_public ? 'Public' : 'Private'}
              </span>
              {isPersonal && profile?.is_self && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-open text-txt-open">
                  You
                </span>
              )}
            </div>
            {isPersonal ? (
              <>
                <p className="text-sm font-medium text-txt-primary mt-0.5">{displayName}</p>
                <p className="text-[11px] font-mono text-txt-tertiary">@{space.uid}</p>
                {profile?.bio && <p className="text-xs text-txt-secondary mt-1">{profile.bio}</p>}
                {(profile?.socials?.length ?? 0) > 0 && (
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    {profile!.socials!.map(s => (
                      <SocialLinkChip key={`${s.platform}-${s.url}`} link={s} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                {space.description && (
                  <p className="text-xs text-txt-secondary mt-0.5">{space.description}</p>
                )}
              </>
            )}
          </div>
        </div>

        {canCreate && (
          <Link
            to="/new-repo"
            className="px-3.5 py-1.5 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover transition shadow-sm flex items-center gap-1.5 self-start sm:self-auto"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{isPersonal ? 'New Repository' : `New Repository in ${space.uid}`}</span>
          </Link>
        )}
      </div>

      {/* Repositories in this namespace */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-txt-secondary uppercase tracking-wider flex items-center gap-2">
          <FolderGit2 className="w-4 h-4 text-brand" />
          <span>Repositories ({repos.length})</span>
        </h2>

        {repos.length === 0 ? (
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
        ) : (
          <div className="border border-border-subtle rounded-lg bg-surface-canvas divide-y divide-border-subtle overflow-hidden">
            {repos.map(r => (
              <div key={r.id} className="p-4 hover:bg-surface-subtle/50 transition flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <FolderGit2 className="w-4 h-4 text-brand" />
                    <Link
                      to={`/${r.path}`}
                      className="font-mono text-sm font-semibold text-txt-brand hover:underline"
                    >
                      {r.uid}
                    </Link>
                    <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary">
                      {r.is_public ? 'Public' : 'Private'}
                    </span>
                  </div>
                  {r.description && <p className="text-xs text-txt-secondary">{r.description}</p>}
                </div>

                <Link
                  to={`/${r.path}`}
                  className="p-1.5 rounded hover:bg-surface-subtle text-txt-tertiary hover:text-txt-primary transition"
                >
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Owner-only onboarding goals */}
      {isPersonal && profile?.is_self && (
        <ProfileGoals uid={space.uid} onChanged={load} />
      )}

      {/* Rendered profile README (public) */}
      {isPersonal && readmeContent && (
        <div className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden">
          <div className="p-3 bg-surface-base border-b border-border-subtle flex items-center gap-2 text-xs font-mono font-semibold text-txt-primary">
            <FileText className="w-4 h-4 text-brand" />
            <span>{profile?.profile_readme?.repo?.readme || 'README.md'}</span>
          </div>
          <div className="p-6">
            <React.Suspense fallback={<p className="text-xs text-txt-tertiary">Loading README…</p>}>
              <Markdown content={readmeContent} />
            </React.Suspense>
          </div>
        </div>
      )}
    </div>
  );
};
