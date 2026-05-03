import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import useAppStore from '../store/useAppStore';


// ─── New Logo Icon ─────────────────────────────────────────────────────────────
const LogoIcon = ({ size = 22, color = "#22d3a4" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
  </svg>
);

// ─── Collapse toggle icon ──────────────────────────────────────────────────────
const CollapseIcon = ({ collapsed }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={{ transition: 'transform 0.3s', transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)' }}>
    <path d="M15 18l-6-6 6-6"/>
  </svg>
);

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const PLAN_META = {
  free: { label: 'Free',  color: '#4a5f80', bg: 'rgba(74,95,128,0.15)',  border: 'rgba(74,95,128,0.25)' },
  pro:  { label: 'Pro',   color: '#22d3a4', bg: 'rgba(34,211,164,0.12)', border: 'rgba(34,211,164,0.25)' },
  max:  { label: 'Max',   color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.25)' },
};

// ─── User Settings Modal ───────────────────────────────────────────────────────
function UserSettingsModal({ onClose }) {
  const { user, plan, updateUser, logout, theme, toggleTheme } = useAuth();
  const navigate   = useNavigate();
  const resetStore = useAppStore(s => s.reset);

  const [tab,     setTab]     = useState('profile');
  const [saving,  setSaving]  = useState(false);
  const [success, setSuccess] = useState('');
  const [error,   setError]   = useState('');

  // Profile tab — pre-filled with current values (name, phone, schoolName are safe to pre-fill)
  const [profile, setProfile] = useState({
    name:       user?.name       || '',
    phone:      user?.phone      || '',
    schoolName: user?.schoolName || '',
  });

  // Email tab — only current email shown as info; new email box starts EMPTY
  const [emailForm, setEmailForm] = useState({ email: '', password: '' });

  // Password tab — all three boxes always start EMPTY
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });

  // M-Pesa tab — credentials always start EMPTY for security
  const [mpesaForm, setMpesaForm] = useState({ consumerKey: '', consumerSecret: '', shortcode: '', passkey: '' });
  const [mpesaConfigured, setMpesaConfigured] = useState(user?.mpesaConfigured || false);

  const showSuccess = msg => { setSuccess(msg); setError(''); setTimeout(() => setSuccess(''), 3000); };
  const showError   = msg => { setError(msg); setSuccess(''); };

  // Reset form state when switching tabs so errors and partial input don't bleed
  const switchTab = (id) => {
    setTab(id);
    setSuccess('');
    setError('');
    if (id === 'email')    setEmailForm({ email: '', password: '' });
    if (id === 'password') setPwForm({ currentPassword: '', newPassword: '', confirm: '' });
    if (id === 'mpesa')    setMpesaForm({ consumerKey: '', consumerSecret: '', shortcode: '', passkey: '' });
  };

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
    if (!emailForm.email.trim()) return showError('Enter your new email address');
    if (!emailForm.password)     return showError('Enter your current password to confirm');
    setSaving(true);
    try {
      const res = await axios.patch(`${API}/api/auth/email`, emailForm);
      updateUser(res.data);
      showSuccess('Email updated. Signing you out…');
      setTimeout(() => { logout(); resetStore(); navigate('/'); }, 2000);
    } catch (e) { showError(e.response?.data?.message || 'Failed to update'); }
    finally { setSaving(false); }
  };

  const savePassword = async () => {
    if (!pwForm.currentPassword)                   return showError('Enter your current password');
    if (!pwForm.newPassword)                        return showError('Enter a new password');
    if (pwForm.newPassword.length < 6)              return showError('Minimum 6 characters');
    if (pwForm.newPassword !== pwForm.confirm)      return showError('Passwords do not match');
    setSaving(true);
    try {
      await axios.patch(`${API}/api/auth/password`, {
        currentPassword: pwForm.currentPassword,
        newPassword:     pwForm.newPassword,
      });
      showSuccess('Password changed successfully');
      setPwForm({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (e) { showError(e.response?.data?.message || 'Failed to update'); }
    finally { setSaving(false); }
  };

  const saveMpesa = async () => {
    if (!mpesaForm.consumerKey.trim() || !mpesaForm.consumerSecret.trim() || !mpesaForm.shortcode.trim() || !mpesaForm.passkey.trim()) {
      return showError('All M-Pesa fields are required');
    }
    setSaving(true);
    try {
      await axios.patch(`${API}/api/auth/mpesa`, mpesaForm);
      setMpesaConfigured(true);
      setMpesaForm({ consumerKey: '', consumerSecret: '', shortcode: '', passkey: '' });
      showSuccess('M-Pesa credentials saved successfully');
    } catch (e) { showError(e.response?.data?.message || 'Failed to save credentials'); }
    finally { setSaving(false); }
  };

  const pm  = PLAN_META[plan] || PLAN_META.free;
  const inp = 'settings-input';
  const lbl = 'settings-label';

  const tabs = [
    { id: 'profile',  label: 'Profile'  },
    { id: 'email',    label: 'Email'    },
    { id: 'password', label: 'Password' },
    { id: 'plan',     label: 'Plan'     },
    { id: 'mpesa',    label: 'M-Pesa'   },
    { id: 'display',  label: 'Display'  },
  ];

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="settings-modal">
        <div className="settings-header">
          <div>
            <div className="settings-title">Account Settings</div>
            <div className="settings-sub">{user?.email}</div>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="settings-body">
          {/* Global honeypot — prevents browser autofill on all tabs */}
          <input type="text" style={{ display: 'none' }} autoComplete="username" readOnly />
          <input type="password" style={{ display: 'none' }} autoComplete="current-password" readOnly />
          <div className="settings-tabs">
            {tabs.map(t => (
              <button key={t.id} className={`settings-tab${tab === t.id ? ' active' : ''}`}
                onClick={() => switchTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>

          {success && <div className="settings-success">✓ {success}</div>}
          {error   && <div className="settings-error">✕ {error}</div>}

          {/* ── Profile — pre-filled, safe to edit ── */}
          {tab === 'profile' && (
            <div className="settings-fields">
              <div className="field-group">
                <label className={lbl}>Full name</label>
                <input className={inp} value={profile.name}
                  onChange={e => setProfile(p => ({ ...p, name: e.target.value }))}
                  placeholder="Your name" />
              </div>
              <div className="field-group">
                <label className={lbl}>Phone number</label>
                <input className={inp} type="tel" value={profile.phone}
                  onChange={e => setProfile(p => ({ ...p, phone: e.target.value }))}
                  placeholder="07XX XXX XXX" />
              </div>
              <div className="field-group">
                <label className={lbl}>School / Institution name</label>
                <input className={inp} value={profile.schoolName}
                  onChange={e => setProfile(p => ({ ...p, schoolName: e.target.value }))}
                  placeholder="Sunrise High School" />
              </div>
              <button className="settings-save-btn" onClick={saveProfile} disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          )}

          {/* ── Email — new address box always starts empty ── */}
          {tab === 'email' && (
            <div className="settings-fields">
              <div className="settings-info-box">
                Current email: <strong>{user?.email}</strong>
              </div>
              <div className="field-group">
                <label className={lbl}>New email address</label>
                <input className={inp} type="email" value={emailForm.email}
                  onChange={e => setEmailForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="new@email.com"
                  autoComplete="off" />
              </div>
              <div className="field-group">
                <label className={lbl}>Current password (to confirm)</label>
                <input className={inp} type="password" value={emailForm.password}
                  onChange={e => setEmailForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="••••••••"
                  autoComplete="current-password" />
              </div>
              <button className="settings-save-btn" onClick={saveEmail} disabled={saving}>
                {saving ? 'Updating…' : 'Update email'}
              </button>
            </div>
          )}

          {/* ── Password — all boxes always empty ── */}
          {tab === 'password' && (
            <div className="settings-fields">
              <div className="field-group">
                <label className={lbl}>Current password</label>
                <input className={inp} type="password" value={pwForm.currentPassword}
                  onChange={e => setPwForm(f => ({ ...f, currentPassword: e.target.value }))}
                  placeholder="••••••••"
                  autoComplete="current-password" />
              </div>
              <div className="field-group">
                <label className={lbl}>New password</label>
                <input className={inp} type="password" value={pwForm.newPassword}
                  onChange={e => setPwForm(f => ({ ...f, newPassword: e.target.value }))}
                  placeholder="Min. 6 characters"
                  autoComplete="new-password" />
              </div>
              <div className="field-group">
                <label className={lbl}>Confirm new password</label>
                <input className={inp} type="password" value={pwForm.confirm}
                  onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
                  placeholder="Repeat new password"
                  autoComplete="new-password" />
              </div>
              <button className="settings-save-btn" onClick={savePassword} disabled={saving}>
                {saving ? 'Changing…' : 'Change password'}
              </button>
            </div>
          )}

          {/* ── Plan ── */}
          {tab === 'plan' && (
            <div className="settings-fields">
              <div className="plan-current">
                <span className="plan-current-badge" style={{ background: pm.bg, color: pm.color, border: `1px solid ${pm.border}` }}>{pm.label}</span>
                {plan === 'free' && <div className="plan-current-sub">Up to 300 students · Manual payments only</div>}
                {plan === 'pro'  && <div className="plan-current-sub">Up to 800 students · M-Pesa + WhatsApp invoices</div>}
                {plan === 'max'  && <div className="plan-current-sub">Unlimited students · Full automation + instant receipts</div>}
              </div>
              {plan === 'free' && (
                <div className="plan-upgrade-options">
                  <div className="plan-upgrade-card" style={{ borderColor: 'rgba(34,211,164,0.25)' }}>
                    <div className="plan-upgrade-name" style={{ color: '#22d3a4' }}>Pro — KES 20,000/mo</div>
                    <div className="plan-upgrade-feat">800 students · M-Pesa STK Push · WhatsApp invoices · Payment reminders</div>
                    <a href="mailto:yahiawarsame@gmail.com?subject=FeeFlow Pro Upgrade" className="plan-upgrade-btn" style={{ background: '#22d3a4', color: '#0b1a14' }}>Upgrade to Pro →</a>
                  </div>
                  <div className="plan-upgrade-card" style={{ borderColor: 'rgba(245,158,11,0.25)' }}>
                    <div className="plan-upgrade-name" style={{ color: '#f59e0b' }}>Max — Custom pricing</div>
                    <div className="plan-upgrade-feat">Unlimited students · Everything in Pro · Instant receipts · Dedicated support</div>
                    <a href="mailto:yahiawarsame@gmail.com?subject=FeeFlow Max Upgrade" className="plan-upgrade-btn" style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.25)' }}>Contact us →</a>
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


          {/* ── M-Pesa — locked for free plan ── */}
          {tab === 'mpesa' && (
            <div className="settings-fields">
              {plan === 'free' ? (
                <>
                  {/* Upgrade gate — fields shown but disabled with overlay */}
                  <div style={{ position: 'relative' }}>
                    <div style={{ filter: 'blur(2px)', pointerEvents: 'none', opacity: 0.4 }}>
                      <div className="field-group">
                        <label className={lbl}>Consumer Key</label>
                        <input className={inp} disabled placeholder="From Safaricom Daraja portal" />
                      </div>
                      <div className="field-group" style={{ marginTop: 12 }}>
                        <label className={lbl}>Consumer Secret</label>
                        <input className={inp} disabled placeholder="From Safaricom Daraja portal" />
                      </div>
                      <div className="field-group" style={{ marginTop: 12 }}>
                        <label className={lbl}>Shortcode (Paybill / Till No.)</label>
                        <input className={inp} disabled placeholder="e.g. 174379" />
                      </div>
                      <div className="field-group" style={{ marginTop: 12 }}>
                        <label className={lbl}>Passkey</label>
                        <input className={inp} disabled placeholder="From Safaricom Daraja portal" />
                      </div>
                    </div>
                    {/* Upgrade overlay */}
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, background: 'rgba(11,26,20,0.7)', borderRadius: 10, backdropFilter: 'blur(1px)' }}>
                      <div style={{ fontSize: 28 }}>🔒</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', textAlign: 'center' }}>M-Pesa Integration</div>
                      <div style={{ fontSize: 12.5, color: 'var(--text3)', textAlign: 'center', maxWidth: 240, lineHeight: 1.5 }}>
                        Upgrade to Pro or Max to link your school's M-Pesa Paybill and collect payments directly.
                      </div>
                      <a href="mailto:yahiawarsame@gmail.com?subject=FeeFlow Pro Upgrade"
                        style={{ padding: '9px 22px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: '#22d3a4', color: '#0b1a14', textDecoration: 'none', marginTop: 4 }}>
                        Upgrade to Pro →
                      </a>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {mpesaConfigured && (
                    <div className="settings-info-box" style={{ borderColor: 'rgba(34,211,164,0.25)', color: 'var(--green)' }}>
                      ✓ M-Pesa is connected. Enter new credentials below to update.
                    </div>
                  )}
                  {!mpesaConfigured && (
                    <div className="settings-info-box">
                      Connect your school's Safaricom Daraja credentials. Each school must have their own Paybill or Till registered with Safaricom.
                    </div>
                  )}
                  {/* Honeypot inputs — prevent browser autofill bleeding into other fields */}
                  <input type="text" style={{ display: 'none' }} autoComplete="username" readOnly />
                  <input type="password" style={{ display: 'none' }} autoComplete="current-password" readOnly />
                  <div className="field-group">
                    <label className={lbl}>Consumer Key</label>
                    <input className={inp} type="password" value={mpesaForm.consumerKey}
                      onChange={e => setMpesaForm(f => ({ ...f, consumerKey: e.target.value }))}
                      placeholder="From Safaricom Daraja portal"
                      autoComplete="new-password" />
                  </div>
                  <div className="field-group">
                    <label className={lbl}>Consumer Secret</label>
                    <input className={inp} type="password" value={mpesaForm.consumerSecret}
                      onChange={e => setMpesaForm(f => ({ ...f, consumerSecret: e.target.value }))}
                      placeholder="From Safaricom Daraja portal"
                      autoComplete="new-password" />
                  </div>
                  <div className="field-group">
                    <label className={lbl}>Shortcode (Paybill / Till No.)</label>
                    <input className={inp} value={mpesaForm.shortcode}
                      onChange={e => setMpesaForm(f => ({ ...f, shortcode: e.target.value }))}
                      placeholder="e.g. 174379" />
                  </div>
                  <div className="field-group">
                    <label className={lbl}>Passkey</label>
                    <input className={inp} type="password" value={mpesaForm.passkey}
                      onChange={e => setMpesaForm(f => ({ ...f, passkey: e.target.value }))}
                      placeholder="From Safaricom Daraja portal"
                      autoComplete="new-password" />
                  </div>
                  <div className="settings-info-box">
                    Your M-Pesa callback URL — paste this in your Daraja app:<br />
                    <code style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--accent)' }}>
                      {`${API}/api/mpesa/callback/${user?.id}`}
                    </code>
                  </div>
                  <button className="settings-save-btn" onClick={saveMpesa} disabled={saving}>
                    {saving ? 'Saving…' : mpesaConfigured ? 'Update credentials' : 'Connect M-Pesa'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── Display ── */}
          {tab === 'display' && (
            <div className="settings-fields">
              <div className="field-group">
                <label className={lbl}>Theme</label>
                <div className="theme-toggle-row">
                  {['dark', 'light'].map(t => (
                    <button key={t} className={`theme-option${theme === t ? ' active' : ''}`}
                      onClick={() => { if (theme !== t) toggleTheme(); }}>
                      {t === 'dark' ? '🌙 Dark' : '☀️ Light'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="settings-info-box">Theme preference is saved to your browser.</div>
            </div>
          )}
        </div>

        {/* Footer — sign out goes to Landing '/' */}
        <div className="settings-footer">
          <button className="settings-logout-btn" onClick={() => { logout(); resetStore(); navigate('/'); }}>
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
  const { user, token, plan } = useAuth();
  const bootstrap    = useAppStore(s => s.bootstrap);
  const loaded       = useAppStore(s => s.termsLoaded);
  // Guard flag — prevents a streaming-bootstrap re-render from triggering a second call
  const bootstrapped = useRef(false);
  // Expose bootstrap via window so ImportStudentsModal can re-fetch after import
  // This is simpler than prop-drilling through every page
  useEffect(() => { window.__ffBootstrap = () => bootstrap(token); }, [token, bootstrap]);

  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen,  setSidebarOpen]  = useState(false);
  const [collapsed,    setCollapsed]    = useState(false);
  const pm = PLAN_META[plan] || PLAN_META.free;

  useEffect(() => {
    if (token && !bootstrapped.current) {
      bootstrapped.current = true;
      bootstrap(token);
    }
  }, [token, bootstrap]);

  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [sidebarOpen]);

  const navItems = [
    {
      path: '/dashboard', label: 'Dashboard',
      icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>,
    },
    {
      path: '/students', label: 'Students',
      icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>,
    },
    {
      path: '/payments', label: 'Payments',
      icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" strokeLinejoin="round" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"/></svg>,
    },
    {
      path: '/invoices', label: 'Invoices & Receipts',
      icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>,
    },
  ];

  if (!loaded) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg)" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <div style={{ width: 28, height: 28, borderRadius: "50%", border: "2px solid var(--border)", borderTop: "2px solid var(--green)", animation: "spin .8s linear infinite" }} />
          <div style={{ fontSize: 13, color: "var(--text3)" }}>Loading FeeFlow…</div>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <div className={`sidebar-overlay${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(false)} />

      <aside className={`sidebar${sidebarOpen ? ' open' : ''}${collapsed ? ' sidebar-collapsed' : ''}`}>

        {/* ── Logo + Collapse on same row ── */}
        <div className="sidebar-logo" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', overflow: 'hidden' }}>
          {/* Logo — clickable */}
          <div onClick={() => navigate('/')} style={{ display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 10, cursor: 'pointer', userSelect: 'none', flex: 1, minWidth: 0 }} title="Go to homepage">
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <LogoIcon size={22} color="#22d3a4" />
            </div>
            {!collapsed && (
              <div style={{ overflow: 'hidden', minWidth: 0 }}>
                <div className="logo-text" style={{ letterSpacing: '0.18em', textTransform: 'uppercase', fontSize: 13, fontWeight: 700 }}>FeeFlow</div>
                <div className="logo-sub">Fee Management</div>
              </div>
            )}
          </div>

          {/* Collapse button — same row as logo */}
          <button
            onClick={() => setCollapsed(col => !col)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="sidebar-collapse-btn"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26, borderRadius: 6, flexShrink: 0,
              background: 'none', border: '1px solid var(--border)',
              cursor: 'pointer', color: 'var(--text3)',
              transition: 'all .15s', padding: 0,
              marginLeft: collapsed ? 'auto' : 0,
              marginRight: collapsed ? 'auto' : 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = 'var(--text)'; e.currentTarget.style.background = 'var(--surface2)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'var(--text3)'; e.currentTarget.style.background = 'none'; }}
          >
            <CollapseIcon collapsed={collapsed} />
          </button>
        </div>

        {/* ── Nav ── */}
        <nav className="sidebar-nav">
          {navItems.map(item => (
            <button
              key={item.path}
              className={`nav-item${location.pathname === item.path ? ' active' : ''}`}
              onClick={() => { navigate(item.path); setSidebarOpen(false); }}
              title={collapsed ? item.label : ''}
              style={{ justifyContent: collapsed ? 'center' : 'flex-start', padding: collapsed ? '10px 0' : undefined }}
            >
              <span className="nav-icon" style={{ flexShrink: 0 }}>{item.icon}</span>
              {!collapsed && <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</span>}
            </button>
          ))}
        </nav>

        {/* ── User card ── */}
        <div className="sidebar-user">
          <button className="user-card"
            onClick={() => { setShowSettings(true); setSidebarOpen(false); }}
            style={{ justifyContent: collapsed ? 'center' : undefined, padding: collapsed ? '10px 0' : undefined }}
            title={collapsed ? `${user?.name} — Settings` : ''}
          >
            <div className="user-avatar" style={{ flexShrink: 0 }}>
              {(user?.name || 'U').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()}
            </div>
            {!collapsed && (
              <>
                <div className="user-info">
                  <div className="user-name">{user?.name || 'User'}</div>
                  <div className="user-school">{user?.schoolName || 'My School'}</div>
                </div>
                <span className="plan-badge" style={{ background: pm.bg, color: pm.color, border: `1px solid ${pm.border}` }}>
                  {pm.label}
                </span>
              </>
            )}
            {collapsed && (
              <span className="plan-badge" style={{ position: 'absolute', top: 4, right: 4, fontSize: 7, padding: '1px 4px', background: pm.bg, color: pm.color, border: `1px solid ${pm.border}`, display: 'none' }}>
                {pm.label}
              </span>
            )}
          </button>
        </div>
      </aside>

      <main className={`main-content${collapsed ? ' main-content-expanded' : ''}`}>
        <Outlet context={{ openSidebar: () => setSidebarOpen(true) }} />
      </main>

      {showSettings && <UserSettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

export { useOutletContext } from 'react-router-dom';