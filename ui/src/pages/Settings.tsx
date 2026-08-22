import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import {
  KeyRound,
  Key,
  User as UserIcon,
  Shield,
  Trash2,
  Fingerprint
} from 'lucide-react';
import { api, User, PublicKey, Token } from '../lib/api';
import { WebAuthnService, StoredPasskey } from '../lib/webauthn';
import { daysToNanoseconds } from '../lib/duration';

interface SettingsProps {
  user: User | null;
}

export const Settings: React.FC<SettingsProps> = ({ user }) => {
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<'profile' | 'passkeys' | 'ssh' | 'tokens'>('profile');

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
        </div>

        {/* Tab Content */}
        <div className="md:col-span-3 space-y-6">
          {/* TAB: PROFILE */}
          {activeTab === 'profile' && user && (
            <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-6">
              <h2 className="text-sm font-semibold text-txt-secondary uppercase tracking-wider">User Profile</h2>
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
                  <span className="text-txt-tertiary block mb-1">Display Name:</span>
                  <span className="text-txt-primary font-semibold">{user.display_name || user.uid}</span>
                </div>
                <div className="p-3 rounded bg-surface-base border border-border-subtle">
                  <span className="text-txt-tertiary block mb-1">Role:</span>
                  <span className="text-txt-brand font-semibold">{user.admin ? 'Administrator' : 'Standard User'}</span>
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

              {generatedToken && (
                <div className="p-4 rounded bg-feedback-success-bg border border-feedback-success-border text-feedback-success-text text-xs space-y-2">
                  <p className="font-bold">Token generated successfully! Copy it now (it won't be shown again):</p>
                  <div className="p-2 rounded bg-surface-canvas border border-border-subtle font-mono text-txt-primary select-all break-all">
                    {generatedToken}
                  </div>
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
        </div>
      </div>
    </div>
  );
};
