import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock, ArrowRight, UserPlus, AlertCircle } from 'lucide-react';
import { api, User } from '../lib/api';

interface RegisterProps {
  onRegisterSuccess: (user: User) => void;
}

export const Register: React.FC<RegisterProps> = ({ onRegisterSuccess }) => {
  const navigate = useNavigate();
  const [uid, setUid] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('nixre_auth_blocked') === 'true') {
      setIsBlocked(true);
    }
  }, []);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBlocked) {
      setError('Registration is closed by the administrator.');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const res = await api.register(uid, email, displayName || uid, password);
      onRegisterSuccess(res.user);
      navigate('/');
    } catch (err: any) {
      setError(err.message || 'Registration failed.');
    } finally {
      setLoading(false);
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
            Create a Nixre Account
          </h1>
          <p className="text-xs text-txt-secondary">
            Join this Nixre instance • nixre.dev
          </p>
        </div>

        {isBlocked ? (
          <div className="p-4 rounded-lg bg-feedback-error-bg border border-feedback-error-border text-center space-y-2">
            <Lock className="w-6 h-6 text-feedback-error-text mx-auto" />
            <h3 className="text-sm font-bold text-feedback-error-text">Public Registration is Closed</h3>
            <p className="text-xs text-feedback-error-text opacity-90">
              New account signups on this instance are currently locked by the administrator.
            </p>
            <div className="pt-2">
              <Link to="/login" className="inline-block text-xs font-semibold text-txt-brand hover:underline">
                Return to Sign In
              </Link>
            </div>
          </div>
        ) : (
          <>
            {error && (
              <div className="p-3 rounded-md bg-feedback-error-bg border border-feedback-error-border text-feedback-error-text text-xs text-center font-medium">
                {error}
              </div>
            )}

            <form onSubmit={handleRegister} className="space-y-3.5">
              <div>
                <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1">
                  Username / UID *
                </label>
                <input
                  type="text"
                  placeholder="e.g. Akicou"
                  value={uid}
                  onChange={e => setUid(e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Akicou"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs focus:border-brand transition"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1">
                  Email Address *
                </label>
                <input
                  type="email"
                  placeholder="user@nixre.dev"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-xs font-mono focus:border-brand transition"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1">
                  Password *
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
                disabled={loading || !uid || !email || !password}
                className="w-full py-2 rounded-md bg-brand text-white font-medium text-xs hover:bg-brand-hover disabled:opacity-50 transition shadow-sm flex items-center justify-center gap-1.5 pt-2.5"
              >
                <span>{loading ? 'Registering...' : 'Create Account'}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </form>

            <div className="text-center pt-2 border-t border-border-subtle text-xs text-txt-tertiary">
              Already have an account?{' '}
              <Link to="/login" className="text-txt-brand hover:underline font-medium">
                Sign in
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
