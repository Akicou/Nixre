import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Shield, Lock, Unlock, Users, Check, MessageSquareWarning } from 'lucide-react';
import { api, User, EnvFeedback } from '../lib/api';
import { Avatar } from '../components/Avatar';
import { isRegistrationHidden, setRegistrationHidden } from '../lib/authLock';

function formatWhen(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function ReportList({ label, items }: { label: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-txt-tertiary font-semibold mb-1">{label}</p>
      <ul className="space-y-0.5">
        {items.map((item, i) => (
          <li key={`${label}-${i}`} className="text-xs text-txt-primary font-mono break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

export const AdminView: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [serverClosed, setServerClosed] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);
  const [browserHidden, setBrowserHidden] = useState(false);
  const [msg, setMsg] = useState('');
  const [reports, setReports] = useState<EnvFeedback[]>([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [openReport, setOpenReport] = useState<string | null>(null);

  useEffect(() => {
    setBrowserHidden(isRegistrationHidden());

    api.listUsers()
      .then(res => {
        setUsers(res);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    api.getRegistrationStatus()
      .then(res => setServerClosed(res.closed))
      .catch(() => setServerClosed(null));
    api.listEnvFeedback()
      .then(rows => setReports(rows))
      .catch(() => setReports([]))
      .finally(() => setReportsLoading(false));
  }, []);

  const toggleServerRegistration = async () => {
    if (serverClosed === null || toggling) return;
    setToggling(true);
    try {
      const res = await api.setRegistrationClosed(!serverClosed);
      setServerClosed(res.closed);
      setMsg(res.closed
        ? 'Registration is now closed server-side — POST /api/v1/register returns 403. Takes effect immediately.'
        : 'Registration is open — new accounts can be created again.');
      setTimeout(() => setMsg(''), 6000);
    } catch (err: any) {
      setMsg(err.message || 'Could not change the registration setting.');
      setTimeout(() => setMsg(''), 6000);
    } finally {
      setToggling(false);
    }
  };

  const toggleAuthBlocking = () => {
    const nextState = !browserHidden;
    setBrowserHidden(nextState);
    setRegistrationHidden(nextState);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8 w-full min-w-0">
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
              <span className="text-sm font-semibold text-txt-primary">Account Registration (server-side)</span>
              <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-bold ${
                serverClosed === null
                  ? 'bg-surface-subtle text-txt-tertiary'
                  : serverClosed
                    ? 'bg-surface-closed text-txt-closed'
                    : 'bg-surface-open text-txt-open'
              }`}>
                {serverClosed === null ? 'UNKNOWN' : serverClosed ? 'CLOSED' : 'OPEN'}
              </span>
            </div>
            <p className="text-xs text-txt-secondary">
              The real kill switch: when closed, <code className="font-mono text-txt-primary">POST /api/v1/register</code> returns
              403 for everyone. Applies immediately and survives restarts. Existing sessions, logins, git and the
              assistant are unaffected.
            </p>
          </div>

          <button
            onClick={toggleServerRegistration}
            disabled={serverClosed === null || toggling}
            className={`px-4 py-2 rounded text-xs font-semibold transition flex items-center gap-2 shrink-0 disabled:opacity-50 ${
              serverClosed
                ? 'bg-surface-open text-txt-open hover:bg-surface-subtle border border-border-subtle'
                : 'bg-feedback-error-bg text-feedback-error-text hover:bg-feedback-error-bg-selected border border-feedback-error-border'
            }`}
          >
            {serverClosed ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
            <span>{toggling ? 'Applying…' : serverClosed ? 'Open Registration' : 'Close Registration'}</span>
          </button>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded bg-surface-base border border-border-subtle gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-txt-primary">Registration Page (this browser only)</span>
              <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-bold ${
                browserHidden ? 'bg-surface-closed text-txt-closed' : 'bg-surface-open text-txt-open'
              }`}>
                {browserHidden ? 'HIDDEN' : 'VISIBLE'}
              </span>
            </div>
            <p className="text-xs text-txt-secondary">
              Cosmetic: hides the sign-up form in this browser only. It does not affect the API — use the
              server-side switch above to actually block account creation.
            </p>
          </div>

          <button
            onClick={toggleAuthBlocking}
            className={`px-4 py-2 rounded text-xs font-semibold transition flex items-center gap-2 shrink-0 ${
              browserHidden
                ? 'bg-surface-open text-txt-open hover:bg-surface-subtle border border-border-subtle'
                : 'bg-surface-subtle text-txt-secondary hover:bg-surface-mid border border-border-subtle'
            }`}
          >
            {browserHidden ? <Unlock className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
            <span>{browserHidden ? 'Show Registration Page' : 'Hide Registration Page'}</span>
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
                <Avatar name={u.uid} url={u.avatar_url} size={28} />
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

      <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-txt-secondary uppercase tracking-wider flex items-center gap-2">
            <MessageSquareWarning className="w-4 h-4 text-brand" />
            <span>Agent environment reports ({reports.length})</span>
          </h2>
        </div>
        <p className="text-xs text-txt-secondary">
          Filed when an agent uses the environment-feedback control. Suggestions only — they do not change the sandbox image.
        </p>

        <div className="border border-border-subtle rounded-md bg-surface-base divide-y divide-border-subtle overflow-hidden">
          {reportsLoading ? (
            <div className="p-8 text-center text-xs text-txt-tertiary font-mono">Loading reports…</div>
          ) : reports.length === 0 ? (
            <div className="p-8 text-center text-xs text-txt-tertiary">
              No sandbox reports yet. Agents file them from the warning icon in the agent composer.
            </div>
          ) : (
            reports.map(row => {
              const report = row.report || {
                missing_binaries: [],
                missing_packages: [],
                missing_nixre_tools: [],
                permission_gaps: [],
                dockerfile_suggestions: [],
                notes: '',
              };
              const open = openReport === row.id;
              return (
                <div key={row.id}>
                  <button
                    type="button"
                    onClick={() => setOpenReport(open ? null : row.id)}
                    className="w-full text-left p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-surface-subtle transition"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-txt-primary truncate">
                        {row.user_id} · {row.repo_path}
                      </p>
                      <p className="text-[11px] text-txt-tertiary truncate">
                        {report.notes || 'No notes'}
                      </p>
                    </div>
                    <span className="text-[10px] font-mono text-txt-tertiary shrink-0">
                      {formatWhen(row.created_at)}
                    </span>
                  </button>
                  {open && (
                    <div className="px-3 pb-3 space-y-3">
                      <div className="flex flex-wrap gap-3 text-[11px]">
                        <Link
                          to={`/agent?repo=${encodeURIComponent(row.repo_path)}`}
                          className="text-txt-brand hover:underline font-medium"
                        >
                          Open in Agent
                        </Link>
                        {row.conversation_id && (
                          <span className="font-mono text-txt-tertiary">{row.conversation_id}</span>
                        )}
                      </div>
                      <div className="grid sm:grid-cols-2 gap-3">
                        <ReportList label="Missing binaries" items={report.missing_binaries} />
                        <ReportList label="Missing packages" items={report.missing_packages} />
                        <ReportList label="Missing Nixre tools" items={report.missing_nixre_tools} />
                        <ReportList label="Permission gaps" items={report.permission_gaps} />
                        <ReportList label="Dockerfile suggestions" items={report.dockerfile_suggestions} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
