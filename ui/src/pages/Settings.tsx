import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  KeyRound,
  Key,
  User as UserIcon,
  Shield,
  Trash2,
  Fingerprint,
  ImagePlus,
  Plus,
  Link2,
  Save,
  Loader2,
  GitBranch,
} from 'lucide-react';
import { api, User, PublicKey, Token, SocialLink, UserSecret } from '../lib/api';
import { WebAuthnService, StoredPasskey } from '../lib/webauthn';
import { daysToNanoseconds } from '../lib/duration';
import { Avatar } from '../components/Avatar';

interface SettingsProps {
  user: User | null;
  onUserChange?: (u: User) => void;
}

export const Settings: React.FC<SettingsProps> = ({ user, onUserChange }) => {
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<'profile' | 'passkeys' | 'ssh' | 'tokens' | 'github'>('profile');

  // Passkeys state
  const [passkeys, setPasskeys] = useState<StoredPasskey[]>([]);
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyError, setPasskeyError] = useState('');
  const [passkeySuccess, setPasskeySuccess] = useState('');
  const [passkeyLoading, setPasskeyLoading] = useState(false);

  // SSH Keys state
  const [publicKeys, setPublicKeys] = useState<PublicKey[]>([]);
  const [sshTitle, setSshTitle] = useState('');
  const [sshContent, setSshContent] = useState('');
  const [sshError, setSshError] = useState('');
  const [sshSuccess, setSshSuccess] = useState('');

  // Tokens state
  const [tokens, setTokens] = useState<Token[]>([]);
  const [tokenTitle, setTokenTitle] = useState('');
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);

  const [githubSecret, setGithubSecret] = useState<UserSecret | null>(null);
  const [githubToken, setGithubToken] = useState('');
  const [githubMsg, setGithubMsg] = useState('');
  const [githubSaving, setGithubSaving] = useState(false);

  // Avatar state
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url || '');
  const [avatarMsg, setAvatarMsg] = useState('');

  // Profile (display name + socials) state
  const [displayName, setDisplayName] = useState(user?.display_name || '');
  const [socials, setSocials] = useState<SocialLink[]>(user?.socials ?? []);
  const [profileMsg, setProfileMsg] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    setAvatarUrl(user?.avatar_url || '');
    setDisplayName(user?.display_name || '');
    setSocials(user?.socials ?? []);
  }, [user?.avatar_url, user?.display_name, user?.socials]);

  useEffect(() => {
    if (location.hash === '#passkeys') {
      setActiveTab('passkeys');
    }
  }, [location.hash]);

  const refreshPasskeys = () => {
    if (!user) return;
    WebAuthnService.getRegisteredPasskeys(user.uid).then(setPasskeys).catch(() => setPasskeys([]));
  };

  const loadAll = () => {
    if (!user) return;
    refreshPasskeys();
    api.listPublicKeys().then(setPublicKeys).catch(() => {});
    api.listTokens().then(setTokens).catch(() => {});
    api.listSecrets().then(list => {
      setGithubSecret(list.find(s => s.kind === 'github' && s.configured) || null);
    }).catch(() => setGithubSecret(null));
  };

  useEffect(() => {
    loadAll();
  }, [user]);

  // Handle Passkey Registration
  const handleAddPasskey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setPasskeyError('');
    setPasskeySuccess('');
    setPasskeyLoading(true);

    try {
      const created = await WebAuthnService.registerPasskey(user, passkeyName || undefined);
      refreshPasskeys();
      setPasskeySuccess(`Passkey "${created.name}" registered successfully!`);
      setPasskeyName('');
    } catch (err: any) {
      setPasskeyError(err.message || 'Failed to register passkey.');
    } finally {
      setPasskeyLoading(false);
    }
  };

  const handleDeletePasskey = (id: string) => {
    WebAuthnService.deletePasskey(id)
      .then(refreshPasskeys)
      .catch(() => setPasskeyError('Could not delete the passkey (sync backend unreachable).'));
  };

  // Handle SSH Key
  const handleAddSshKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setSshError('');
    setSshSuccess('');

    try {
      await api.addPublicKey(sshTitle, sshContent);
      setSshSuccess('SSH Key added successfully!');
      setSshTitle('');
      setSshContent('');
      loadAll();
    } catch (err: any) {
      setSshError(err.message || 'Failed to add SSH key.');
    }
  };

  const handleDeleteSshKey = async (identifier: string) => {
    try {
      await api.deletePublicKey(identifier);
      loadAll();
    } catch {}
  };

  // Handle Token
  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenTitle) return;
    try {
      const res = await api.createToken(tokenTitle, daysToNanoseconds(30));
      setGeneratedToken(res.access_token);
      setTokenTitle('');
      loadAll();
    } catch {}
  };

  const handleSaveGithub = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = githubToken.trim();
    if (!token) return;
    setGithubMsg('');
    setGithubSaving(true);
    try {
      const saved = await api.setGithubSecret(token);
      setGithubSecret(saved);
      setGithubToken('');
      setGithubMsg('GitHub token saved. The agent will use it on the next conversation.');
    } catch (err: any) {
      setGithubMsg(err.message || 'Failed to save GitHub token.');
    } finally {
      setGithubSaving(false);
    }
  };

  const handleRemoveGithub = async () => {
    setGithubMsg('');
    try {
      await api.deleteGithubSecret();
      setGithubSecret(null);
      setGithubToken('');
      setGithubMsg('GitHub token removed.');
    } catch (err: any) {
      setGithubMsg(err.message || 'Failed to remove GitHub token.');
    }
  };

  const handleAvatarFile = async (file: File) => {
    if (!file || !user) return;
    setAvatarMsg('');
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result || '').split(',')[1] || '';
      try {
        const res = await api.setUserAvatar(base64, file.type);
        const url = `${res.avatar_url}?v=${Date.now()}`;
        setAvatarUrl(url);
        onUserChange?.({ ...user, avatar_url: url });
      } catch (err: any) {
        setAvatarMsg(err.message || 'Failed to upload avatar.');
      }
    };
    reader.readAsDataURL(file);
  };

  const handleAvatarRemove = async () => {
    if (!user) return;
    setAvatarMsg('');
    try {
      await api.removeUserAvatar();
      setAvatarUrl('');
      onUserChange?.({ ...user, avatar_url: '' });
    } catch (err: any) {
      setAvatarMsg(err.message || 'Failed to remove avatar.');
    }
  };

  const saveProfile = async () => {
    if (!user) return;
    setProfileMsg('');
    setSavingProfile(true);
    try {
      const updated = await api.updateUserProfile({
        display_name: displayName,
        socials: socials.filter(s => s.platform.trim() && s.url.trim()),
      });
      onUserChange?.(updated);
      setProfileMsg('Saved.');
    } catch (err: any) {
      setProfileMsg(err.message || 'Failed to save profile.');
    } finally {
      setSavingProfile(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8 w-full min-w-0">
      {/* Settings Header */}
      <div className="border-b border-border-subtle pb-4">
        <h1 className="text-xl font-bold text-txt-primary">Account & Security Settings</h1>
        <p className="text-xs text-txt-secondary mt-1">
          Manage your profile, biometric passkeys, SSH keys, and personal access tokens.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
        {/* Sidebar Tabs */}
        <div className="space-y-1">
          <button
            onClick={() => setActiveTab('profile')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition text-left ${
              activeTab === 'profile' ? 'bg-surface-subtle text-txt-primary font-semibold' : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle/50'
            }`}
          >
            <UserIcon className="w-4 h-4" />
            <span>Profile</span>
          </button>

          <button
            onClick={() => setActiveTab('passkeys')}
            className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-xs font-medium transition text-left ${
              activeTab === 'passkeys' ? 'bg-surface-subtle text-txt-primary font-semibold' : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle/50'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <KeyRound className="w-4 h-4 text-txt-brand" />
              <span>Passkeys / FIDO2</span>
            </div>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-open text-txt-open">
              {passkeys.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('ssh')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition text-left ${
              activeTab === 'ssh' ? 'bg-surface-subtle text-txt-primary font-semibold' : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle/50'
            }`}
          >
            <Key className="w-4 h-4" />
            <span>SSH Keys</span>
          </button>

          <button
            onClick={() => setActiveTab('tokens')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition text-left ${
              activeTab === 'tokens' ? 'bg-surface-subtle text-txt-primary font-semibold' : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle/50'
            }`}
          >
            <Shield className="w-4 h-4" />
            <span>Access Tokens</span>
          </button>

          <button
            onClick={() => setActiveTab('github')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition text-left ${
              activeTab === 'github' ? 'bg-surface-subtle text-txt-primary font-semibold' : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle/50'
            }`}
          >
            <GitBranch className="w-4 h-4" />
            <span>GitHub</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="md:col-span-3 space-y-6">
          {/* TAB: PROFILE */}
          {activeTab === 'profile' && user && (
            <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-6">
              <h2 className="text-sm font-semibold text-txt-secondary uppercase tracking-wider">User Profile</h2>

              <div className="flex items-center gap-5 flex-wrap">
                <Avatar name={user.uid} url={avatarUrl} size={80} />
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-surface-base border border-border-subtle text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition cursor-pointer">
                      <ImagePlus className="w-3.5 h-3.5" />
                      <span>Upload avatar</span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleAvatarFile(f); }}
                      />
                    </label>
                    {avatarUrl && (
                      <button
                        onClick={handleAvatarRemove}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-surface-base border border-border-subtle text-txt-secondary hover:text-feedback-error-text transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Remove</span>
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-txt-tertiary">PNG, JPEG, WebP, or GIF — up to 2MB. Shown on your profile and commits.</p>
                  {avatarMsg && <p className="text-xs text-feedback-error-text">{avatarMsg}</p>}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 font-mono text-xs">
                <div className="p-3 rounded bg-surface-base border border-border-subtle">
                  <span className="text-txt-tertiary block mb-1">Username / UID:</span>
                  <span className="text-txt-primary font-semibold">{user.uid}</span>
                </div>
                <div className="p-3 rounded bg-surface-base border border-border-subtle">
                  <span className="text-txt-tertiary block mb-1">Email:</span>
                  <span className="text-txt-primary font-semibold">{user.email}</span>
                </div>
                <div className="p-3 rounded bg-surface-base border border-border-subtle">
                  <span className="text-txt-tertiary block mb-1">Role:</span>
                  <span className="text-txt-brand font-semibold">{user.admin ? 'Administrator' : 'Standard User'}</span>
                </div>
              </div>

              <div className="space-y-4 pt-2 border-t border-border-subtle">
                <div>
                  <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm focus:border-brand transition"
                  />
                </div>

                <div>
                  <span className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
                    Social Links
                  </span>
                  <p className="text-[11px] text-txt-tertiary mb-2">
                    Add links to show on your public profile — e.g. GitHub, X/Twitter, LinkedIn, or your site.
                  </p>
                  <div className="space-y-2">
                    {socials.map((s, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <Link2 className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-txt-tertiary" />
                          <input
                            type="text"
                            placeholder="platform (e.g. github)"
                            value={s.platform}
                            onChange={e => setSocials(prev => prev.map((s2, idx) => (idx === i ? { ...s2, platform: e.target.value } : s2)))}
                            className="w-full pl-8 pr-2 py-1.5 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
                          />
                        </div>
                        <input
                          type="text"
                          placeholder="https://…"
                          value={s.url}
                          onChange={e => setSocials(prev => prev.map((s2, idx) => (idx === i ? { ...s2, url: e.target.value } : s2)))}
                          className="flex-1 px-2 py-1.5 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
                        />
                        <button
                          type="button"
                          onClick={() => setSocials(prev => prev.filter((_, idx) => idx !== i))}
                          className="p-1.5 rounded hover:bg-feedback-error-bg text-txt-tertiary hover:text-feedback-error-text transition"
                          title="Remove link"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    {socials.length === 0 && (
                      <p className="text-[11px] text-txt-tertiary">No social links yet.</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSocials(prev => [...prev, { platform: '', url: '' }])}
                    className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-surface-base border border-border-subtle text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add social link</span>
                  </button>
                </div>

                <div className="flex items-center justify-end gap-3">
                  {profileMsg && (
                    <span className={`text-[11px] ${profileMsg === 'Saved.' ? 'text-txt-open' : 'text-feedback-error-text'}`}>
                      {profileMsg}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={saveProfile}
                    disabled={savingProfile}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition shadow-sm"
                  >
                    {savingProfile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    <span>{savingProfile ? 'Saving…' : 'Save'}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB: PASSKEYS */}
          {activeTab === 'passkeys' && (
            <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border-subtle pb-4">
                <div>
                  <h2 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
                    <Fingerprint className="w-4 h-4 text-brand" />
                    <span>Passkeys & WebAuthn Credentials</span>
                  </h2>
                  <p className="text-xs text-txt-secondary mt-0.5">
                    Sign in seamlessly using Face ID, Touch ID, Windows Hello, or hardware security keys (YubiKey).
                  </p>
                </div>
              </div>

              {passkeyError && (
                <div className="p-3 rounded bg-feedback-error-bg border border-feedback-error-border text-feedback-error-text text-xs">
                  {passkeyError}
                </div>
              )}

              {passkeySuccess && (
                <div className="p-3 rounded bg-feedback-success-bg border border-feedback-success-border text-feedback-success-text text-xs">
                  {passkeySuccess}
                </div>
              )}

              {/* Add Passkey Form */}
              <form onSubmit={handleAddPasskey} className="flex flex-col sm:flex-row items-end gap-3 p-4 rounded bg-surface-base border border-border-subtle">
                <div className="flex-1 w-full">
                  <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1">
                    Passkey Label / Device Name
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. MacBook Pro Touch ID or YubiKey 5C"
                    value={passkeyName}
                    onChange={e => setPasskeyName(e.target.value)}
                    className="w-full px-3 py-2 rounded-md bg-surface-canvas border border-border-subtle text-txt-primary text-xs focus:border-brand transition"
                  />
                </div>
                <button
                  type="submit"
                  disabled={passkeyLoading}
                  className="w-full sm:w-auto px-4 py-2 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition shadow-sm flex items-center justify-center gap-1.5 shrink-0"
                >
                  <Fingerprint className="w-4 h-4" />
                  <span>{passkeyLoading ? 'Prompting Device...' : 'Register New Passkey'}</span>
                </button>
              </form>

              {/* Registered Passkeys List */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider">
                  Registered Devices ({passkeys.length})
                </h3>

                {passkeys.length === 0 ? (
                  <div className="p-6 text-center border border-dashed border-border-subtle rounded-md text-xs text-txt-tertiary">
                    No passkeys registered on this account yet. Click "Register New Passkey" to add one.
                  </div>
                ) : (
                  <div className="divide-y divide-border-subtle border border-border-subtle rounded-md bg-surface-base overflow-hidden">
                    {passkeys.map(pk => (
                      <div key={pk.id} className="p-3 flex items-center justify-between gap-3 text-xs">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded bg-surface-subtle text-txt-brand">
                            <Fingerprint className="w-4 h-4" />
                          </div>
                          <div>
                            <p className="font-semibold text-txt-primary">{pk.name}</p>
                            <p className="text-[11px] text-txt-tertiary font-mono">
                              Created {new Date(pk.createdAt).toLocaleDateString()}
                              {pk.lastUsedAt && ` • Last used ${new Date(pk.lastUsedAt).toLocaleDateString()}`}
                            </p>
                          </div>
                        </div>

                        <button
                          onClick={() => handleDeletePasskey(pk.id)}
                          className="p-1.5 rounded hover:bg-feedback-error-bg text-txt-tertiary hover:text-feedback-error-text transition"
                          title="Delete Passkey"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB: SSH KEYS */}
          {activeTab === 'ssh' && (
            <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-6">
              <h2 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
                <Key className="w-4 h-4 text-brand" />
                <span>SSH Public Keys</span>
              </h2>

              <div className="p-3 rounded bg-surface-base border border-border-subtle text-[11px] leading-relaxed text-txt-secondary">
                <p className="font-semibold text-txt-primary mb-1">Clone over SSH (no password prompts)</p>
                <p>Register a key below, then use the SSH remote URL — port 3022 must be reachable:</p>
                <pre className="mt-2 p-2 rounded bg-surface-canvas border border-border-subtle font-mono text-txt-primary overflow-x-auto">git clone ssh://git@&lt;host&gt;:3022/&lt;space&gt;/&lt;repo&gt;.git</pre>
              </div>

              {sshError && <div className="p-3 rounded bg-feedback-error-bg text-feedback-error-text text-xs">{sshError}</div>}
              {sshSuccess && <div className="p-3 rounded bg-feedback-success-bg text-feedback-success-text text-xs">{sshSuccess}</div>}

              <form onSubmit={handleAddSshKey} className="space-y-3 p-4 rounded bg-surface-base border border-border-subtle">
                <div>
                  <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1">
                    Key Title
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. My Laptop"
                    value={sshTitle}
                    onChange={e => setSshTitle(e.target.value)}
                    className="w-full px-3 py-2 rounded-md bg-surface-canvas border border-border-subtle text-txt-primary text-xs focus:border-brand transition"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1">
                    Public Key Content
                  </label>
                  <textarea
                    rows={3}
                    placeholder="Begins with 'ssh-ed25519' or 'ssh-rsa'..."
                    value={sshContent}
                    onChange={e => setSshContent(e.target.value)}
                    className="w-full px-3 py-2 rounded-md bg-surface-canvas border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
                    required
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="px-4 py-2 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover transition shadow-sm"
                  >
                    Add SSH Key
                  </button>
                </div>
              </form>

              {/* List SSH Keys */}
              <div className="space-y-2">
                {publicKeys.map(k => (
                  <div key={k.identifier} className="p-3 rounded bg-surface-base border border-border-subtle flex items-center justify-between text-xs font-mono">
                    <div>
                      <span className="font-semibold text-txt-primary">{k.identifier}</span>
                      <p className="text-txt-tertiary text-[11px] truncate max-w-md">{k.fingerprint || k.content}</p>
                    </div>
                    <button
                      onClick={() => handleDeleteSshKey(k.identifier)}
                      className="p-1.5 rounded hover:bg-feedback-error-bg text-txt-tertiary hover:text-feedback-error-text transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB: ACCESS TOKENS */}
          {activeTab === 'tokens' && (
            <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-6">
              <h2 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
                <Shield className="w-4 h-4 text-brand" />
                <span>Personal Access Tokens</span>
              </h2>

              <div className="p-3 rounded bg-surface-base border border-border-subtle text-[11px] leading-relaxed text-txt-secondary">
                <p className="font-semibold text-txt-primary mb-1">Tokens are the password for git over HTTPS</p>
                <p>
                  <code className="font-mono text-txt-primary">git clone</code> and <code className="font-mono text-txt-primary">git push</code> never
                  accept your account password. When git prompts for credentials, enter your username and an access
                  token as the password:
                </p>
                <pre className="mt-2 p-2 rounded bg-surface-canvas border border-border-subtle font-mono text-txt-primary overflow-x-auto">git clone https://&lt;username&gt;:&lt;token&gt;@git.example.com/git/&lt;space&gt;/&lt;repo&gt;.git</pre>
              </div>

              {generatedToken && (
                <div className="p-4 rounded bg-feedback-success-bg border border-feedback-success-border text-feedback-success-text text-xs space-y-2">
                  <p className="font-bold">Token generated successfully! Copy it now (it won't be shown again):</p>
                  <div className="p-2 rounded bg-surface-canvas border border-border-subtle font-mono text-txt-primary select-all break-all">
                    {generatedToken}
                  </div>
                  <p className="text-feedback-success-text/80">
                    Use this token as the password when git asks for credentials over HTTPS.
                  </p>
                </div>
              )}

              <form onSubmit={handleCreateToken} className="flex gap-3">
                <input
                  type="text"
                  placeholder="Token name (e.g. CI/CD or CLI)"
                  value={tokenTitle}
                  onChange={e => setTokenTitle(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs focus:border-brand transition"
                  required
                />
                <button
                  type="submit"
                  className="px-4 py-2 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover transition shadow-sm"
                >
                  Generate Token
                </button>
              </form>

              <div className="space-y-2">
                {tokens.map(t => (
                  <div key={t.identifier} className="p-3 rounded bg-surface-base border border-border-subtle flex items-center justify-between text-xs font-mono">
                    <div>
                      <span className="font-semibold text-txt-primary">{t.identifier}</span>
                      <p className="text-txt-tertiary text-[11px]">Expires {new Date(t.expires_at).toLocaleDateString()}</p>
                    </div>
                    <button
                      onClick={() => api.deleteToken(t.identifier).then(loadAll)}
                      className="p-1.5 rounded hover:bg-feedback-error-bg text-txt-tertiary hover:text-feedback-error-text transition"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'github' && (
            <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-6">
              <h2 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-brand" />
                <span>GitHub personal access token</span>
              </h2>
              <p className="text-xs text-txt-secondary leading-relaxed">
                Stored encrypted and injected into the agent as <code className="font-mono text-txt-primary">GITHUB_TOKEN</code> plus a git credential helper for github.com. Use it for private clones and the GitHub API. The token is never shown again after save.
              </p>
              {githubSecret?.configured && (
                <p className="text-xs text-txt-primary font-mono">Configured {githubSecret.key_mask}</p>
              )}
              {githubMsg && (
                <div className={`p-3 rounded text-xs ${
                  githubMsg.startsWith('Failed')
                    ? 'bg-feedback-error-bg border border-feedback-error-border text-feedback-error-text'
                    : 'bg-feedback-success-bg border border-feedback-success-border text-feedback-success-text'
                }`}>
                  {githubMsg}
                </div>
              )}
              <form onSubmit={handleSaveGithub} className="flex flex-col sm:flex-row gap-3">
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="ghp_… or github_pat_…"
                  value={githubToken}
                  onChange={e => setGithubToken(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
                  required
                />
                <button
                  type="submit"
                  disabled={githubSaving}
                  className="px-4 py-2 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition shadow-sm"
                >
                  {githubSaving ? 'Saving…' : 'Save'}
                </button>
              </form>
              {githubSecret?.configured && (
                <button
                  type="button"
                  onClick={handleRemoveGithub}
                  className="px-4 py-2 rounded border border-feedback-error-border text-feedback-error-text text-xs font-semibold hover:bg-feedback-error-bg transition"
                >
                  Remove GitHub token
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
