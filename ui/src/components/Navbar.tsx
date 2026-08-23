import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Layers,
  Settings,
  Settings2,
  Shield,
  LogOut,
  Sun,
  Moon,
  KeyRound,
  Plus,
  ChevronDown,
  Sparkles,
  User as UserIcon
} from 'lucide-react';
import { api, User, Space } from '../lib/api';
import { currentSpaceFromPathname } from '../lib/repoPath';
import { useOutsideClick } from '../lib/useOutsideClick';
import { isPluginLive } from '../lib/pluginPreferences';
import { BrandMark } from './BrandMark';

interface NavbarProps {
  currentUser: User | null;
  onLogout: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentUser, onLogout }) => {
  const location = useLocation();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [isDark, setIsDark] = useState(true);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [spaceDropdownOpen, setSpaceDropdownOpen] = useState(false);
  const [assistantLive, setAssistantLive] = useState(false);
  const spaceMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useOutsideClick(spaceMenuRef, () => setSpaceDropdownOpen(false), spaceDropdownOpen);
  useOutsideClick(userMenuRef, () => setUserDropdownOpen(false), userDropdownOpen);

  useEffect(() => {
    if (currentUser) {
      api.listSpaces().then(setSpaces).catch(() => {});
      isPluginLive('nixre-assistant').then(setAssistantLive).catch(() => {});
    }
  }, [currentUser]);

  const activeSpaceUid = currentSpaceFromPathname(location.pathname);
  const activeSpace = spaces.find(s => s.uid === activeSpaceUid);
  const switcherLabel = activeSpace?.uid || spaces[0]?.uid || 'Spaces';

  const toggleTheme = () => {
    const nextTheme = isDark ? 'light' : 'dark';
    setIsDark(!isDark);
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('nixre_theme', nextTheme);
  };

  useEffect(() => {
    const savedTheme = localStorage.getItem('nixre_theme') || 'dark';
    setIsDark(savedTheme === 'dark');
    document.documentElement.setAttribute('data-theme', savedTheme);
  }, []);

  return (
    <header className="border-b border-border-subtle bg-surface-canvas/90 backdrop-blur sticky top-0 z-50 overflow-x-clip">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 flex items-center justify-between gap-2 sm:gap-4 min-w-0">
        {/* Brand & Space Switcher */}
        <div className="flex items-center gap-2 sm:gap-6 min-w-0 flex-1">
          <Link to="/" className="flex items-center gap-2 shrink-0 font-semibold tracking-tight text-txt-primary hover:opacity-90" title="Nixre">
            <BrandMark size="sm" alt="" />
            <span className="hidden sm:inline text-base font-semibold tracking-wide">Nixre</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-subtle text-txt-tertiary border border-border-subtle hidden md:inline">
              nixre.dev
            </span>
          </Link>

          {currentUser && (
            <div className="relative min-w-0" ref={spaceMenuRef}>
              <button
                onClick={() => setSpaceDropdownOpen(!spaceDropdownOpen)}
                className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-2.5 py-1.5 rounded-md text-xs font-medium text-txt-primary bg-surface-base border border-border-subtle hover:border-border-strong transition max-w-full min-w-0"
              >
                <Layers className="w-3.5 h-3.5 text-brand shrink-0" />
                <span className="font-semibold truncate">{switcherLabel}</span>
                {spaces.length > 1 && (
                  <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-surface-subtle text-txt-tertiary shrink-0 hidden sm:inline">
                    +{spaces.length - 1}
                  </span>
                )}
                <ChevronDown className="w-3 h-3 opacity-60 shrink-0" />
              </button>

              {spaceDropdownOpen && (
                <div 
                  className="absolute left-0 mt-1.5 w-60 rounded-md bg-surface-canvas border border-border-mid shadow-xl py-1 z-50 animate-pop"
                  onClick={() => setSpaceDropdownOpen(false)}
                >
                  <div className="px-3 py-1.5 text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider border-b border-border-subtle flex justify-between items-center">
                    <span>Organizations & Spaces</span>
                    <span className="font-mono">{spaces.length}</span>
                  </div>
                  {spaces.map(s => (
                    <Link
                      key={s.uid}
                      to={`/${s.uid}`}
                      className="flex items-center justify-between px-3 py-2 text-xs text-txt-primary hover:bg-surface-subtle transition font-mono"
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded bg-surface-subtle border border-border-subtle flex items-center justify-center text-[10px] font-bold text-txt-brand">
                          {s.uid.slice(0, 2).toUpperCase()}
                        </div>
                        <span className="font-semibold">{s.uid}</span>
                      </div>
                      <span className="text-[10px] text-txt-tertiary uppercase">{s.is_public ? 'Public' : 'Private'}</span>
                    </Link>
                  ))}
                  <div className="border-t border-border-subtle pt-1 mt-1">
                    <Link
                      to="/new-space"
                      className="flex items-center gap-2 px-3 py-2 text-xs font-medium text-txt-brand hover:bg-surface-subtle transition"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Create New Space</span>
                    </Link>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
          {currentUser ? (
            <>
              {/* Agentic engineering workspace — only when the assistant plugin is live */}
              {assistantLive && (
                <>
                  <Link
                    to="/agent"
                    title="Agentic engineering workspace"
                    className={`hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border transition ${
                      location.pathname === '/agent'
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-border-subtle text-txt-secondary hover:text-txt-primary hover:border-border-mid'
                    }`}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Agent</span>
                  </Link>
                  <Link
                    to="/agent"
                    title="Agent workspace"
                    className={`sm:hidden min-h-11 min-w-11 flex items-center justify-center rounded border transition ${
                      location.pathname === '/agent'
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-border-subtle text-txt-secondary hover:text-txt-primary'
                    }`}
                  >
                    <Sparkles className="w-4 h-4" />
                  </Link>
                </>
              )}
              <Link
                to="/new-repo"
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover transition shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Repository</span>
              </Link>
              <Link
                to="/new-repo"
                title="New repository"
                className="sm:hidden min-h-11 min-w-11 flex items-center justify-center rounded bg-brand text-white hover:bg-brand-hover transition shadow-sm"
              >
                <Plus className="w-4 h-4" />
              </Link>

              {/* Theme Toggle */}
              <button
                onClick={toggleTheme}
                title="Toggle Dark/Light Mode"
                className="p-2 rounded text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
              >
                {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>

              {/* User Dropdown */}
              <div className="relative" ref={userMenuRef}>
                <button
                  onClick={() => setUserDropdownOpen(!userDropdownOpen)}
                  className="flex items-center gap-2 pl-2 pr-1.5 py-1 rounded hover:bg-surface-subtle transition border border-transparent hover:border-border-subtle"
                >
                  <div className="w-6 h-6 rounded-full bg-surface-mid border border-border-subtle flex items-center justify-center font-mono text-xs font-bold text-txt-primary uppercase">
                    {currentUser.uid.slice(0, 2)}
                  </div>
                  <span className="text-xs font-medium text-txt-primary hidden md:inline">{currentUser.uid}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-txt-tertiary" />
                </button>

                {userDropdownOpen && (
                  <div 
                    className="absolute right-0 mt-1.5 w-60 rounded-md bg-surface-canvas border border-border-mid shadow-lg py-1 z-50 animate-pop"
                    onClick={() => setUserDropdownOpen(false)}
                  >
                    <div className="px-3 py-2 border-b border-border-subtle">
                      <p className="text-sm font-semibold text-txt-primary">{currentUser.display_name || currentUser.uid}</p>
                      <p className="text-xs text-txt-tertiary truncate">{currentUser.email}</p>
                    </div>

                    <Link
                      to={`/${currentUser.uid}`}
                      className="flex items-center gap-2.5 px-3 py-2 text-sm text-txt-primary hover:bg-surface-subtle transition"
                    >
                      <UserIcon className="w-4 h-4 text-txt-brand" />
                      <span>View Profile</span>
                    </Link>

                    <Link
                      to="/settings"
                      className="flex items-center gap-2.5 px-3 py-2 text-sm text-txt-primary hover:bg-surface-subtle transition"
                    >
                      <Settings className="w-4 h-4 text-txt-tertiary" />
                      <span>Settings & Profile</span>
                    </Link>

                    <Link
                      to="/settings#passkeys"
                      className="flex items-center gap-2.5 px-3 py-2 text-sm text-txt-primary hover:bg-surface-subtle transition"
                    >
                      <KeyRound className="w-4 h-4 text-txt-brand" />
                      <span className="flex-1">Passkeys / FIDO2</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-open text-txt-open font-semibold">Active</span>
                    </Link>

                    <Link
                      to="/plugins"
                      className="flex items-center gap-2.5 px-3 py-2 text-sm text-txt-primary hover:bg-surface-subtle transition"
                    >
                      <Settings2 className="w-4 h-4 text-txt-tertiary" />
                      <span>Plugins</span>
                    </Link>

                    {currentUser.admin && (
                      <Link
                        to="/admin"
                        className="flex items-center gap-2.5 px-3 py-2 text-sm text-txt-primary hover:bg-surface-subtle transition"
                      >
                        <Shield className="w-4 h-4 text-txt-tertiary" />
                        <span>Admin Console</span>
                      </Link>
                    )}

                    <div className="border-t border-border-subtle my-1"></div>

                    <button
                      onClick={onLogout}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-feedback-error-text hover:bg-feedback-error-bg transition text-left"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Sign Out</span>
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={toggleTheme}
                className="p-2 rounded text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition mr-1"
              >
                {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
              <Link
                to="/login"
                className="px-3 py-1.5 rounded text-sm text-txt-secondary hover:text-txt-primary transition"
              >
                Sign In
              </Link>
              <Link
                to="/register"
                className="px-3 py-1.5 rounded text-sm font-medium bg-brand text-white hover:bg-brand-hover transition shadow-sm"
              >
                Register
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
