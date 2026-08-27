import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { Dashboard } from './pages/Dashboard';
import { SpaceView } from './pages/SpaceView';
import { RepoView } from './pages/RepoView';
import { NewRepo } from './pages/NewRepo';
import { NewSpace } from './pages/NewSpace';
import { Settings } from './pages/Settings';
import { AdminView } from './pages/AdminView';
import { Plugins } from './pages/Plugins';
import { AssistantPage } from './pages/AssistantPage';
import { AgentWorkspace } from './pages/AgentWorkspace';
import { DeploymentsPage } from './pages/DeploymentsPage';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { api, User } from './lib/api';
import { migrateLegacyLocalStorage } from './lib/syncApi';
import { BrandMark } from './components/BrandMark';

export const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.currentUser()
      .then(user => {
        setCurrentUser(user);
        setLoading(false);
        // One-time upload of localStorage-era data to the sync backend.
        migrateLegacyLocalStorage().catch(() => {});
      })
      .catch(() => {
        setCurrentUser(null);
        setLoading(false);
      });
  }, []);

  const handleLogout = async () => {
    await api.logout();
    setCurrentUser(null);
    window.location.href = '/login';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-base flex flex-col items-center justify-center gap-3">
        <BrandMark size="md" />
        <p className="font-mono text-xs text-txt-tertiary">Initializing Nixre...</p>
      </div>
    );
  }

  return (
    <Router>
      <AppShell currentUser={currentUser} onLogout={handleLogout} setCurrentUser={setCurrentUser} />
    </Router>
  );
};

const AppShell: React.FC<{
  currentUser: User | null;
  onLogout: () => void;
  setCurrentUser: (u: User | null) => void;
}> = ({ currentUser, onLogout, setCurrentUser }) => {
  const location = useLocation();
  // Agent workspace is an immersive surface — no site footer, main fills the viewport.
  const immersive = location.pathname === '/agent';

  return (
    <div className="min-h-screen bg-surface-base flex flex-col font-sans overflow-x-clip max-w-[100vw]">
      <Navbar currentUser={currentUser} onLogout={onLogout} />

      <main className={immersive ? 'flex-1 min-h-0 min-w-0 overflow-hidden' : 'flex-1 min-w-0 overflow-x-clip'}>
        <Routes>
          <Route path="/" element={currentUser ? <Dashboard user={currentUser} /> : <Navigate to="/login" />} />
          <Route path="/new-repo" element={currentUser ? <NewRepo /> : <Navigate to="/login" />} />
          <Route path="/new-space" element={currentUser ? <NewSpace /> : <Navigate to="/login" />} />
          <Route path="/settings" element={currentUser ? <Settings user={currentUser} onUserChange={setCurrentUser} /> : <Navigate to="/login" />} />
          <Route path="/admin" element={currentUser && currentUser.admin ? <AdminView /> : <Navigate to="/" />} />
          <Route path="/plugins" element={currentUser ? <Plugins /> : <Navigate to="/login" />} />
          <Route path="/agent" element={currentUser ? <AgentWorkspace /> : <Navigate to="/login" />} />
          <Route path="/:space/:repo/assistant" element={currentUser ? <AssistantPage /> : <Navigate to="/login" />} />
          <Route path="/:space/:repo/deployments" element={currentUser ? <DeploymentsPage /> : <Navigate to="/login" />} />

          <Route path="/login" element={currentUser ? <Navigate to="/" /> : <Login onLoginSuccess={setCurrentUser} />} />
          <Route path="/register" element={currentUser ? <Navigate to="/" /> : <Register onRegisterSuccess={setCurrentUser} />} />

          <Route path="/:space" element={<SpaceView />} />
          <Route path="/:space/:repo" element={<RepoView />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>

      {!immersive && (
        <footer className="border-t border-border-subtle py-4 px-4 sm:px-6 text-center font-mono text-[11px] text-txt-tertiary overflow-x-clip">
          <span className="inline-block max-w-full break-words">Nixre • Sovereign Code Collaboration • <a href="https://nixre.dev" target="_blank" rel="noreferrer" className="hover:text-txt-brand underline">nixre.dev</a></span>
        </footer>
      )}
    </div>
  );
};
