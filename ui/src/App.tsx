import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
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
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { api, User } from './lib/api';
import { migrateLegacyLocalStorage } from './lib/syncApi';

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
      <div className="min-h-screen bg-surface-base flex items-center justify-center font-mono text-xs text-txt-tertiary">
        Initializing Nixre...
      </div>
    );
  }

  return (
    <Router>
      <div className="min-h-screen bg-surface-base flex flex-col font-sans">
        <Navbar currentUser={currentUser} onLogout={handleLogout} />

        <main className="flex-1">
          <Routes>
            <Route path="/" element={currentUser ? <Dashboard user={currentUser} /> : <Navigate to="/login" />} />
            <Route path="/new-repo" element={currentUser ? <NewRepo /> : <Navigate to="/login" />} />
            <Route path="/new-space" element={currentUser ? <NewSpace /> : <Navigate to="/login" />} />
            <Route path="/settings" element={currentUser ? <Settings user={currentUser} /> : <Navigate to="/login" />} />
            <Route path="/admin" element={currentUser && currentUser.admin ? <AdminView /> : <Navigate to="/" />} />
            <Route path="/plugins" element={currentUser ? <Plugins /> : <Navigate to="/login" />} />
            <Route path="/agent" element={currentUser ? <AgentWorkspace /> : <Navigate to="/login" />} />
            <Route path="/:space/:repo/assistant" element={currentUser ? <AssistantPage /> : <Navigate to="/login" />} />
            
            <Route path="/login" element={currentUser ? <Navigate to="/" /> : <Login onLoginSuccess={setCurrentUser} />} />
            <Route path="/register" element={currentUser ? <Navigate to="/" /> : <Register onRegisterSuccess={setCurrentUser} />} />

            <Route path="/:space" element={<SpaceView />} />
            <Route path="/:space/:repo" element={<RepoView />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>

        <footer className="border-t border-border-subtle py-4 px-6 text-center font-mono text-[11px] text-txt-tertiary">
          <span>Nixre • Sovereign Code Collaboration • <a href="https://nixre.dev" target="_blank" rel="noreferrer" className="hover:text-txt-brand underline">nixre.dev</a></span>
        </footer>
      </div>
    </Router>
  );
};
