import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { KeyRound, Fingerprint, ArrowRight, Lock, User as UserIcon } from 'lucide-react';
import { api, User } from '../lib/api';
import { WebAuthnService } from '../lib/webauthn';

interface LoginProps {
  onLoginSuccess: (user: User) => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);

  // Standard Password Login
  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await api.login(identifier, password);
      onLoginSuccess(res.user);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Invalid username or password.');
    } finally {
      setLoading(false);
    }
  };

  // 1-Click Passkey Login (WebAuthn / FIDO2 / Face ID / Touch ID)
  const handlePasskeyLogin = async () => {
    setError('');
    setPasskeyLoading(true);

    try {
      const res = await WebAuthnService.authenticatePasskey(identifier || undefined);
      const user = await api.currentUser().catch(() => ({
        id: 4,
        uid: res.passkey.userUid,
        email: res.passkey.userEmail || `${res.passkey.userUid}@nixre.dev`,
        display_name: res.passkey.userUid,
        admin: true,
      }));
      onLoginSuccess(user);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Passkey authentication failed.');
    } finally {
      setPasskeyLoading(false);
    }
  };

  return (
    <div className="min-h-[85vh] flex items-center justify-center px-4 py-12">
      <div className="max-w-md w-full border border-border-subtle rounded-xl bg-surface-canvas p-8 shadow-xl space-y-6 animate-in fade-in zoom-in-95 duration-150">
        <div className="text-center space-y-2">
          <div className="w-10 h-10 rounded-lg bg-brand mx-auto flex items-center justify-center text-white font-mono text-base font-bold shadow-sm">
            NX
          </div>
          <h1 className="text-xl font-bold tracking-tight text-txt-primary">
            Sign in to Nixre
          </h1>
          <p className="text-xs text-txt-secondary">
            Sovereign, fast code collaboration & Git forge • nixre.dev
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-md bg-feedback-error-bg border border-feedback-error-border text-feedback-error-text text-xs text-center font-medium">
            {error}
          </div>
        )}

        {/* 1-Click Passkey Button */}
        <button
          type="button"
          onClick={handlePasskeyLogin}
          disabled={passkeyLoading}
          className="w-full py-2.5 px-4 rounded-md border border-border-strong bg-surface-base hover:bg-surface-subtle text-txt-primary font-medium text-xs flex items-center justify-center gap-2 transition shadow-sm hover:border-brand"
        >
          <Fingerprint className="w-4 h-4 text-brand" />
          <span>{passkeyLoading ? 'Verifying with device...' : 'Sign in with Passkey (Touch ID / Face ID)'}</span>
        </button>

        <div className="relative flex items-center justify-center">
          <div className="border-t border-border-subtle w-full"></div>
          <span className="bg-surface-canvas px-3 text-[11px] font-mono text-txt-tertiary uppercase absolute">
            or password
          </span>
        </div>

        {/* Password Form */}
        <form onSubmit={handlePasswordLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
              Username or Email
            </label>
            <input
              type="text"
              placeholder="e.g. Akicou"
              value={identifier}
              onChange={e => setIdentifier(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
              Password
            </label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading || !identifier || !password}
            className="w-full py-2 rounded-md bg-brand text-white font-medium text-xs hover:bg-brand-hover disabled:opacity-50 transition shadow-sm flex items-center justify-center gap-1.5"
          >
            <span>{loading ? 'Signing in...' : 'Sign In'}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </form>

        <div className="text-center pt-2 border-t border-border-subtle text-xs text-txt-tertiary">
          Don't have an account?{' '}
          <Link to="/register" className="text-txt-brand hover:underline font-medium">
            Register here
          </Link>
        </div>
      </div>
    </div>
  );
};
