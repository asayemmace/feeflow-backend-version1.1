import { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const PLAN_META = {
  free: { label: 'Free',  color: '#4a5f80', bg: 'rgba(74,95,128,0.15)',  border: 'rgba(74,95,128,0.25)' },
  pro:  { label: 'Pro',   color: '#22d3a4', bg: 'rgba(34,211,164,0.12)', border: 'rgba(34,211,164,0.25)' },
  max:  { label: 'Max',   color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.25)' },
};

// ─── User Settings Modal ───────────────────────────────────────────────────────
function UserSettingsModal({ onClose }) {
  const { user, plan, updateUser, logout, theme, toggleTheme } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab]       = useState('profile');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError]   = useState('');

  const [profile, setProfile] = useState({ name: user?.name || '', phone: user?.phone || '', schoolName: user?.schoolName || '' });
  const [emailForm, setEmailForm]   = useState({ email: user?.email || '', password: '' });
  const [pwForm, setPwForm]         = useState({ currentPassword: '', newPassword: '', confirm: '' });

  const showSuccess = (msg) => { setSuccess(msg); setError(''); setTimeout(() => setSuccess(''), 3000); };
  const showError   = (msg) => { setError(msg);   setSuccess(''); };

  const saveProfile = async () => {
    setSaving(true);
    try {
      const res = await axios.patch(`${API}/api/auth/profile`, profile);
      updateUser(res.data);
      showSuccess('Profile updated successfully');
    } catch (e) { showError(e.response?.data?.message || 'Failed to update'); }
    finally { setSaving(false); }
  };

  const saveEmail = async () => {
    if (!emailForm.email || !emailForm.password) return showError('Fill all fields');
    setSaving(true);
    try {
      const res = await axios.patch(`${API}/api/auth/email`, emailForm);
      updateUser(res.data);
      showSuccess('Email updated. Please log in again.');
      setTimeout(() => { logout(); navigate('/login'); }, 2000);
    } catch (e) { showError(e.response?.data?.message || 'Failed to update'); }
    finally { setSaving(false); }
  };

  const savePassword = async () => {
    if (pwForm.newPassword !== pwForm.confirm) return showError('Passwords do not match');
    if (pwForm.newPassword.length < 6) return showError('Minimum 6 characters');
    setSaving(true);
    try {
      await axios.patch(`${API}/api/auth/password`, { currentPassword: pwForm.currentPassword, newPassword: pwForm.newPassword });
      showSuccess('Password changed successfully');
      setPwForm({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (e) { showError(e.response?.data?.message || 'Failed to update'); }
    finally { setSaving(false); }
  };

  const pm = PLAN_META[plan] || PLAN_META.free;

  const inp = 'settings-input';
  const lbl = 'settings-label';

  const tabs = [
    { id: 'profile',  label: 'Profile' },
    { id: 'email',    label: 'Email' },
    { id: 'password', label: 'Password' },
    { id: 'plan',     label: 'Plan & Billing' },
    { id: 'display',  label: 'Display' },
  ];

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="settings-modal">
        {/* Header */}
        <div className="settings-header">
          <div>
            <div className="settings-title">Account Settings</div>
            <div className="settings-sub">{user?.email}</div>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="settings-body">
          {/* Tabs */}
          <div className="settings-tabs">
            {tabs.map(t => (
              <button key={t.id} className={`settings-tab${tab === t.id ? ' active' : ''}`} onClick={() => { setTab(t.id); setSuccess(''); setError(''); }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Feedback */}
          {success && <div className="settings-success">✓ {success}</div>}
          {error   && <div className="settings-error">✕ {error}</div>}

          {/* Profile tab */}
          {tab === 'profile' && (
            <div className="settings-fields">
              <div className="field-group">
                <label className={lbl}>Full name</label>
                <input className={inp} value={profile.name} onChange={e => setProfile(p => ({ ...p, name: e.target.value }))} placeholder="Your name" />
              </div>
              <div className="field-group">
                <label className={lbl}>Phone number</label>
                <input className={inp} value={profile.phone} onChange={e => setProfile(p => ({ ...p, phone: e.target.value }))} placeholder="07XX XXX XXX" />
              </div>
              <div className="field-group">
                <label className={lbl}>School / Institution name</label>
                <input className={inp} value={profile.schoolName} onChange={e => setProfile(p => ({ ...p, schoolName: e.target.value }))} placeholder="Sunrise High School" />
              </div>
              <button className="settings-save-btn" onClick={saveProfile} disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          )}

          {/* Email tab */}
          {tab === 'email' && (
            <div className="settings-fields">
              <div className="settings-info-box">
                Current email: <strong>{user?.email}</strong>
              </div>
              <div className="field-group">
                <label className={lbl}>New email address</label>
                <input className={inp} type="email" value={emailForm.email} onChange={e => setEmailForm(f => ({ ...f, email: e.target.value }))} placeholder="new@email.com" />
              </div>
              <div className="field-group">
                <label className={lbl}>Current password (to confirm)</label>
                <input className={inp} type="password" value={emailForm.password} onChange={e => setEmailForm(f => ({ ...f, password: e.target.value }))} placeholder="••••••••" />
              </div>
              <button className="settings-save-btn" onClick={saveEmail} disabled={saving}>
                {saving ? 'Updating…' : 'Update email'}
              </button>
            </div>
          )}

          {/* Password tab */}
          {tab === 'password' && (
            <div className="settings-fields">
              <div className="field-group">
                <label className={lbl}>Current password</label>
                <input className={inp} type="password" value={pwForm.currentPassword} onChange={e => setPwForm(f => ({ ...f, currentPassword: e.target.value }))} placeholder="••••••••" />
              </div>
              <div className="field-group">
                <label className={lbl}>New password</label>
                <input className={inp} type="password" value={pwForm.newPassword} onChange={e => setPwForm(f => ({ ...f, newPassword: e.target.value }))} placeholder="Min. 6 characters" />
              </div>
              <div className="field-group">
                <label className={lbl}>Confirm new password</label>
                <input className={inp} type="password" value={pwForm.confirm} onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))} placeholder="Repeat new password" />
              </div>
              <button className="settings-save-btn" onClick={savePassword} disabled={saving}>
                {saving ? 'Changing…' : 'Change password'}
              </button>
            </div>
          )}

          {/* Plan tab */}
          {tab === 'plan' && (
            <div className="settings-fields">
              <div className="plan-current-card" style={{ borderColor: pm.border, background: pm.bg }}>
                <div className="plan-current-label" style={{ color: pm.color }}>Current plan</div>
                <div className="plan-current-name" style={{ color: pm.color }}>{pm.label}</div>
                {plan === 'free' && <div className="plan-current-sub">Up to 300 students · No M-Pesa integration</div>}
                {plan === 'pro'  && <div className="plan-current-sub">Up to 800 students · M-Pesa + WhatsApp invoices</div>}
                {plan === 'max'  && <div className="plan-current-sub">Unlimited students · Full automation + instant receipts</div>}
              </div>

              {plan === 'free' && (
                <div className="plan-upgrade-options">
                  <div className="plan-upgrade-card" style={{ borderColor: 'rgba(34,211,164,0.25)' }}>
                    <div className="plan-upgrade-name" style={{ color: '#22d3a4' }}>Pro — KES 20,000/mo</div>
                    <div className="plan-upgrade-feat">800 students · M-Pesa STK Push · WhatsApp invoices · Payment reminders</div>
                    <a href="mailto:yahiawarsame@gmail.com?subject=FeeFlow Pro Upgrade" className="plan-upgrade-btn" style={{ background: '#22d3a4', color: '#0b1a14' }}>
                      Upgrade to Pro →
                    </a>
                  </div>
                  <div className="plan-upgrade-card" style={{ borderColor: 'rgba(245,158,11,0.25)' }}>
                    <div className="plan-upgrade-name" style={{ color: '#f59e0b' }}>Max — Custom pricing</div>
                    <div className="plan-upgrade-feat">Unlimited students · Everything in Pro · Instant receipts · Dedicated support</div>
                    <a href="mailto:yahiawarsame@gmail.com?subject=FeeFlow Max Upgrade" className="plan-upgrade-btn" style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.25)' }}>
                      Contact us →
                    </a>
                  </div>
                </div>
              )}
              {plan !== 'free' && (
                <div className="settings-info-box">
                  To change or cancel your plan, email <a href="mailto:yahiawarsame@gmail.com" style={{ color: 'var(--accent)' }}>yahiawarsame@gmail.com</a>
                </div>
              )}
            </div>
          )}

          {/* Display tab */}
          {tab === 'display' && (
            <div className="settings-fields">
              <div className="field-group">
                <label className={lbl}>Theme</label>
                <div className="theme-toggle-row">
                  {['dark', 'light'].map(t => (
                    <button key={t} className={`theme-option${theme === t ? ' active' : ''}`} onClick={() => { if (theme !== t) toggleTheme(); }}>
                      {t === 'dark' ? '🌙 Dark' : '☀️ Light'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-info-box">
                Theme preference is saved to your browser.
              </div>
            </div>
          )}
        </div>

        {/* Footer — logout */}
        <div className="settings-footer">
          <button className="settings-logout-btn" onClick={() => { logout(); navigate('/login'); }}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
            </svg>
            Sign out
          </button>
        </div>
      </div>
    </>
  );
}

// ─── App Layout ────────────────────────────────────────────────────────────────
export default function AppLayout() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const { user, plan } = useAuth();
  const [showSettings, setShowSettings] = useState(false);
  const pm = PLAN_META[plan] || PLAN_META.free;

  const navItems = [
    { path: '/dashboard', label: 'Dashboard', icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg> },
    { path: '/students',  label: 'Students',  icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg> },
    { path: '/payments',  label: 'Payments',  icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" strokeLinejoin="round" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"/></svg> },
  ];

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-mark">
            <div className="logo-icon">F</div>
            <div>
              <div className="logo-text">FeeFlow</div>
              <div className="logo-sub">Fee Management</div>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(item => (
            <button
              key={item.path}
              className={`nav-item${location.pathname === item.path ? ' active' : ''}`}
              onClick={() => navigate(item.path)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* User card at bottom — click opens settings */}
        <div className="sidebar-user">
          <button className="user-card" onClick={() => setShowSettings(true)}>
            <div className="user-avatar">
              {(user?.name || 'U').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()}
            </div>
            <div className="user-info">
              <div className="user-name">{user?.name || 'User'}</div>
              <div className="user-school">{user?.schoolName || 'My School'}</div>
            </div>
            <span className="plan-badge" style={{ background: pm.bg, color: pm.color, border: `1px solid ${pm.border}` }}>
              {pm.label}
            </span>
          </button>
        </div>
      </aside>

      {/* Main scroll area — this is the scroll container, NOT the window */}
      <main className="main-content">
        <Outlet />
      </main>

      {showSettings && <UserSettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
