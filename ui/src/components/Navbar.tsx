import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { 
  GitBranch, 
  Layers, 
  Settings, 
  Shield, 
  LogOut, 
  Sun, 
  Moon, 
  KeyRound, 
  Plus, 
  User as UserIcon,
  Search,
  Check,
  ChevronDown
} from 'lucide-react';
import { api, User, Space } from '../lib/api';

interface NavbarProps {
  currentUser: User | null;
  onLogout: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ currentUser, onLogout }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [isDark, setIsDark] = useState(true);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [spaceDropdownOpen, setSpaceDropdownOpen] = useState(false);

  useEffect(() => {
    if (currentUser) {
      api.listSpaces().then(setSpaces).catch(() => {});
    }
  }, [currentUser]);

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
    <header className="border-b border-border-subtle bg-surface-canvas/90 backdrop-blur sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        {/* Brand & Space Switcher */}
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight text-txt-primary hover:opacity-90">
            <div className="w-7 h-7 rounded bg-brand flex items-center justify-center text-white font-mono text-sm font-bold shadow-sm">
              NX
            </div>
            <span className="text-base font-semibold tracking-wide">Nixre</span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface-subtle text-txt-tertiary border border-border-subtle hidden sm:inline">
              nixre.dev
            </span>
          </Link>

          {currentUser && (
            <div className="relative">
              <button 
                onClick={() => setSpaceDropdownOpen(!spaceDropdownOpen)}
                className="flex items-center gap-2 px-2.5 py-1 rounded text-sm text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition border border-transparent hover:border-border-subtle"
              >
                <Layers className="w-4 h-4 text-txt-tertiary" />
                <span>Spaces</span>
                <ChevronDown className="w-3.5 h-3.5 opacity-60" />
              </button>

              {spaceDropdownOpen && (
                <div 
                  className="absolute left-0 mt-1.5 w-56 rounded-md bg-surface-canvas border border-border-mid shadow-lg py-1 z-50 animate-in fade-in zoom-in-95 duration-100"
                  onClick={() => setSpaceDropdownOpen(false)}
                >
                  <div className="px-3 py-1.5 text-xs font-semibold text-txt-tertiary uppercase tracking-wider border-b border-border-subtle">
                    Organizations & Spaces
                  </div>
                  {spaces.map(s => (
                    <Link
                      key={s.uid}
                      to={`/${s.uid}`}
                      className="flex items-center justify-between px-3 py-2 text-sm text-txt-primary hover:bg-surface-subtle transition"
                    >
                      <span className="font-medium">{s.uid}</span>
                      <span className="text-xs text-txt-tertiary">{s.is_public ? 'Public' : 'Private'}</span>
                    </Link>
                  ))}
                  <div className="border-t border-border-subtle pt-1 mt-1">
                    <Link
                      to="/new-space"
                      className="flex items-center gap-2 px-3 py-2 text-sm text-txt-brand hover:bg-surface-subtle transition"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Create New Space</span>
                    </Link>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-3">
          {currentUser ? (
            <>
              <Link
                to="/new-repo"
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover transition shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Repository</span>
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
              <div className="relative">
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
                    className="absolute right-0 mt-1.5 w-60 rounded-md bg-surface-canvas border border-border-mid shadow-lg py-1 z-50 animate-in fade-in zoom-in-95 duration-100"
                    onClick={() => setUserDropdownOpen(false)}
                  >
                    <div className="px-3 py-2 border-b border-border-subtle">
                      <p className="text-sm font-semibold text-txt-primary">{currentUser.display_name || currentUser.uid}</p>
                      <p className="text-xs text-txt-tertiary truncate">{currentUser.email}</p>
                    </div>

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
