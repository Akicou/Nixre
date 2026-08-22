import React, { useState, useEffect } from 'react';
import { Shield, Lock, Unlock, Users, Check } from 'lucide-react';
import { api, User } from '../lib/api';
import { isRegistrationHidden, setRegistrationHidden } from '../lib/authLock';

export const AdminView: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [authBlocked, setAuthBlocked] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setAuthBlocked(isRegistrationHidden());

    api.listUsers()
      .then(res => {
        setUsers(res);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const toggleAuthBlocking = () => {
    const nextState = !authBlocked;
    setAuthBlocked(nextState);
    setRegistrationHidden(nextState);
    setMsg(nextState
      ? 'Registration page is now hidden in this browser. This does NOT stop the API — block POST /api/v1/register at your reverse proxy for real enforcement.'
      : 'Registration page is visible again in this browser.');
    setTimeout(() => setMsg(''), 6000);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      <div className="border-b border-border-subtle pb-4">
        <h1 className="text-xl font-bold text-txt-primary flex items-center gap-2">
          <Shield className="w-5 h-5 text-brand" />
          <span>Instance Administration & Security</span>
        </h1>
        <p className="text-xs text-txt-secondary mt-1">
          Manage system security, user registrations, and platform configuration.
        </p>
      </div>

      {msg && (
        <div className="p-3 rounded bg-feedback-success-bg border border-feedback-success-border text-feedback-success-text text-xs flex items-center gap-2">
          <Check className="w-4 h-4 shrink-0" />
          <span>{msg}</span>
        </div>
      )}

      {/* Security Controls */}
      <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-4">
        <h2 className="text-sm font-semibold text-txt-primary uppercase tracking-wider">
          Authentication & Access Control
        </h2>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded bg-surface-base border border-border-subtle gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-txt-primary">Registration Page (this browser only)</span>
              <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-bold ${
                authBlocked ? 'bg-surface-closed text-txt-closed' : 'bg-surface-open text-txt-open'
              }`}>
                {authBlocked ? 'HIDDEN' : 'VISIBLE'}
              </span>
            </div>
            <p className="text-xs text-txt-secondary">
              This only hides the sign-up page in browsers where it's toggled &mdash; it does not stop
              account creation via the API. To actually close the instance, set{' '}
              <code className="font-mono text-txt-primary">GITNESS_USER_SIGNUP_ENABLED=false</code> on the server and restart.
            </p>
          </div>

          <button
            onClick={toggleAuthBlocking}
            className={`px-4 py-2 rounded text-xs font-semibold transition flex items-center gap-2 shrink-0 ${
              authBlocked
                ? 'bg-surface-open text-txt-open hover:bg-surface-subtle border border-border-subtle'
                : 'bg-feedback-error-bg text-feedback-error-text hover:bg-feedback-error-bg-selected border border-feedback-error-border'
            }`}
          >
            {authBlocked ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
            <span>{authBlocked ? 'Show Registration Page' : 'Hide Registration Page'}</span>
          </button>
        </div>
      </div>

      {/* Registered Users */}
      <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-txt-secondary uppercase tracking-wider flex items-center gap-2">
            <Users className="w-4 h-4 text-brand" />
            <span>Registered Accounts ({users.length})</span>
          </h2>
        </div>

        <div className="border border-border-subtle rounded-md bg-surface-base divide-y divide-border-subtle overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-xs text-txt-tertiary font-mono">Loading accounts...</div>
          ) : users.map(u => (
            <div key={u.id} className="p-3 flex items-center justify-between gap-4 text-xs font-mono">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full bg-surface-subtle border border-border-subtle flex items-center justify-center font-bold text-txt-primary uppercase">
                  {u.uid.slice(0, 2)}
                </div>
                <div>
                  <p className="font-semibold text-txt-primary">{u.display_name || u.uid} <span className="text-txt-tertiary">(@{u.uid})</span></p>
                  <p className="text-[11px] text-txt-tertiary">{u.email}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className={`text-[10px] uppercase font-mono px-2 py-0.5 rounded border border-border-subtle ${
                  u.admin ? 'bg-surface-merged text-txt-merged font-bold' : 'text-txt-secondary'
                }`}>
                  {u.admin ? 'Admin' : 'User'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
