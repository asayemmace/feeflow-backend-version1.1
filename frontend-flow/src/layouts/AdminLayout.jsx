import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Sidebar from './Sidebar';

const PAGE_META = {
  '/dashboard': { title: 'Dashboard',  sub: 'Monday, 12 May 2025 · Term 2, Week 6' },
  '/students':  { title: 'Students',   sub: '542 students enrolled · Term 2, 2025' },
  '/payments':  { title: 'Payments',   sub: 'M-Pesa & manual payments' },
};

const SunIcon = () => (
  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
      d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/>
  </svg>
);

const MoonIcon = () => (
  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
      d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/>
  </svg>
);

const AdminLayout = () => {
  const { theme, toggleTheme } = useAuth();
  const location = useLocation();
  const meta = PAGE_META[location.pathname] || { title: 'FeeFlow', sub: '' };

  return (
    <div className="shell">
      <Sidebar />

      <main className="main">
        {/* Topbar */}
        <div className="topbar">
          <div>
            <div className="topbar-title">{meta.title}</div>
            <div className="topbar-sub">{meta.sub}</div>
          </div>
          <div className="topbar-actions">
            <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
            <button className="btn btn-primary">
              <svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/>
              </svg>
              Record Payment
            </button>
          </div>
        </div>

        {/* Page content */}
        <div className="content">
          <Outlet />
        </div>
      </main>
    </div>
  );
};

export default AdminLayout;
