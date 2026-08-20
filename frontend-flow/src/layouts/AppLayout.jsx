import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import useAppStore from '../store/useAppStore';
import PasswordInput from '../components/PasswordInput';
import analytics from '../analytics/analytics';


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

const assetUrl = (url) => {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `${API}${url.startsWith('/') ? url : `/${url}`}`;
};

const PLAN_META = {
  free: { label: 'Free',  color: '#4a5f80', bg: 'rgba(74,95,128,0.15)',  border: 'rgba(74,95,128,0.25)' },
  pro:  { label: 'Pro',   color: '#22d3a4', bg: 'rgba(34,211,164,0.12)', border: 'rgba(34,211,164,0.25)' },
  max:  { label: 'Max',   color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.25)' },
};

// ─── Billing Modal ─────────────────────────────────────────────────────────────
const BillingModal = ({ onClose, onSuccess, user }) => {
  const [phone, setPhone] = useState(() => {
    const p = String(user?.phone || '').replace(/\D/g, '');
    if (/^(254|0)[17]\d{8}$/.test(p)) return p.startsWith('254') ? '0' + p.slice(3) : p;
    return '';
  });
  const [stage, setStage]         = useState('confirm');
  const [error, setError]         = useState('');
  const [checkoutId, setCheckoutId] = useState(null);
  const [mpesaRef, setMpesaRef]   = useState('');
  const [failMsg, setFailMsg]     = useState('');
  const pollRef = useRef(null);

  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => () => stopPolling(), []);

  const startPolling = (cid) => {
    let attempts = 0;
    const MAX_ATTEMPTS = 24;
    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const res = await axios.get(`${API}/api/billing/status/${cid}`);
        const { status, mpesaRef: ref, resultDesc } = res.data;
        if (status === 'SUCCESS') {
          stopPolling(); setMpesaRef(ref || ''); setStage('success');
          if (res.data.user) onSuccess(res.data.user);
        } else if (status === 'FAILED') {
          stopPolling(); setFailMsg(resultDesc || 'Payment was not completed.'); setStage('failed');
        } else if (attempts >= MAX_ATTEMPTS) {
          stopPolling(); setFailMsg('Payment timed out. Check your M-Pesa messages or try again.'); setStage('failed');
        }
      } catch {
        if (attempts >= MAX_ATTEMPTS) { stopPolling(); setFailMsg('Could not confirm payment status. Check your M-Pesa messages.'); setStage('failed'); }
      }
    }, 5000);
  };

  const handleSubmit = async () => {
    setError('');
    const digits = phone.replace(/\D/g, '');
    const normalized = digits.startsWith('0') ? '254' + digits.slice(1) : digits.startsWith('254') ? digits : '254' + digits;
    if (!/^254[17]\d{8}$/.test(normalized)) { setError('Enter a valid Safaricom number (07XX or 01XX).'); return; }
    setStage('waiting');
    try {
      const res = await axios.post(`${API}/api/billing/subscribe`, { plan: 'pro', phone });
      setCheckoutId(res.data.checkoutRequestId);
      startPolling(res.data.checkoutRequestId);
    } catch (e) {
      setError(e.response?.data?.message || 'Could not initiate payment. Please try again.');
      setStage('confirm');
    }
  };

  const overlay = { position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
  const card    = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 20, padding: 32, width: '100%', maxWidth: 420, position: 'relative' };
  const closeBtn = { position: 'absolute', top: 16, right: 16, background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4 };

  if (stage === 'confirm') return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={card}>
        <button style={closeBtn} onClick={onClose}>✕</button>
        <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 700, color: '#22d3a4', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Upgrade to Pro</div>
        <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4, letterSpacing: '-0.02em' }}>
          KES 20,000 <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text3)' }}>/month</span>
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 24, lineHeight: 1.5 }}>800 students · M-Pesa STK Push · SMS &amp; email invoices · Payment reminders</p>
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', display: 'block', marginBottom: 6 }}>M-Pesa phone number</label>
          <input
            type="tel" placeholder="e.g. 0712 345 678" value={phone}
            onChange={e => { setPhone(e.target.value); setError(''); }}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 10, fontSize: 15, background: 'var(--surface2)', border: `1px solid ${error ? '#ef4444' : 'var(--border)'}`, color: 'var(--text)', outline: 'none', fontFamily: 'inherit' }}
            autoFocus
          />
          {error && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>{error}</div>}
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>You will receive an M-Pesa STK push to complete the payment.</div>
        </div>
        <button className="btn btn-primary" style={{ width: '100%', padding: '13px', borderRadius: 10, fontSize: 14, fontWeight: 700 }} onClick={handleSubmit}>
          Pay KES 20,000 via M-Pesa
        </button>
        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22d3a4" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>Secured via Safaricom Daraja API · TLS encrypted</span>
        </div>
      </div>
    </div>
  );

  if (stage === 'waiting') return (
    <div style={overlay}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', margin: '0 auto 20px', border: '3px solid var(--border)', borderTopColor: '#22d3a4', animation: 'billing-spin 0.9s linear infinite' }} />
        <style>{`@keyframes billing-spin { to { transform: rotate(360deg); } }`}</style>
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Check your phone</h3>
        <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 20 }}>
          An M-Pesa prompt has been sent to <strong>{phone}</strong>. Enter your PIN to complete.
        </p>
        <div style={{ background: 'rgba(34,211,164,0.05)', border: '1px solid rgba(34,211,164,0.15)', borderRadius: 10, padding: '10px 14px', fontSize: 12, color: 'var(--text2)' }}>
          Waiting for confirmation… this may take up to 2 minutes.
        </div>
      </div>
    </div>
  );

  if (stage === 'success') return (
    <div style={overlay}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(34,211,164,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 26 }}>✓</div>
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: '#22d3a4' }}>Plan activated!</h3>
        <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 16 }}>Your <strong>Pro plan</strong> is now active. All Pro features are unlocked.</p>
        {mpesaRef && <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 14px', fontSize: 12, color: 'var(--text3)', marginBottom: 20 }}>M-Pesa receipt: <strong style={{ color: 'var(--text)' }}>{mpesaRef}</strong></div>}
        <button className="btn btn-primary" style={{ width: '100%', padding: '12px', borderRadius: 10, fontSize: 14 }} onClick={onClose}>Continue to dashboard</button>
      </div>
    </div>
  );

  if (stage === 'failed') return (
    <div style={overlay}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(239,68,68,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 26, color: '#ef4444' }}>✕</div>
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Payment not completed</h3>
        <p style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 20 }}>{failMsg || 'The payment did not go through. You have not been charged.'}</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-outline" style={{ flex: 1, padding: '11px', borderRadius: 10, fontSize: 14 }} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 1, padding: '11px', borderRadius: 10, fontSize: 14 }} onClick={() => { setStage('confirm'); setError(''); setFailMsg(''); }}>Try again</button>
        </div>
      </div>
    </div>
  );

  return null;
};

const STAFF_PERMISSION_GROUPS = [
  {
    title: 'Students',
    desc: 'View and maintain student records.',
    permissions: [
      ['students.view', 'View students'],
      ['students.create', 'Add students'],
      ['students.edit', 'Edit students'],
      ['students.delete', 'Delete students'],
    ],
  },
  {
    title: 'Payments',
    desc: 'Record, review, and reverse payments.',
    permissions: [
      ['payments.view', 'View payments'],
      ['payments.create', 'Add payments'],
      ['payments.reverse', 'Reverse payments'],
    ],
  },
  {
    title: 'Invoices',
    desc: 'Create and send fee invoices.',
    permissions: [
      ['invoices.view', 'View invoices'],
      ['invoices.create', 'Create invoices'],
      ['invoices.send', 'Send invoices'],
    ],
  },
  { title: 'Receipts', desc: 'Access official payment receipts.', permissions: [['receipts.view', 'View receipts']] },
  { title: 'Reports', desc: 'Download financial and term reports.', permissions: [['reports.view', 'View reports']] },
  { title: 'Terms', desc: 'Create, edit, and close school terms, including term fee configuration.', permissions: [['terms.manage', 'Manage terms']] },
  {
    title: 'Settings',
    desc: 'View or update school account settings.',
    permissions: [
      ['settings.view', 'View settings'],
      ['settings.edit', 'Edit settings'],
    ],
  },
  {
    title: 'M-Pesa',
    desc: 'View or update payment integration settings.',
    permissions: [
      ['mpesa.view', 'View M-Pesa setup'],
      ['mpesa.edit', 'Edit M-Pesa setup'],
    ],
  },
];

const ALL_STAFF_PERMISSIONS = STAFF_PERMISSION_GROUPS.flatMap(group => group.permissions.map(([key]) => key));
const STAFF_ROLE_PRESETS = {
  Accountant: ['payments.view', 'payments.create', 'payments.reverse', 'invoices.view', 'invoices.create', 'invoices.send', 'receipts.view', 'reports.view'],
  Receptionist: ['students.view', 'students.create', 'students.edit', 'payments.view', 'payments.create', 'invoices.view', 'receipts.view'],
  Viewer: ['students.view', 'payments.view', 'invoices.view', 'receipts.view', 'reports.view'],
  Manager: ALL_STAFF_PERMISSIONS.filter(permission => permission !== 'mpesa.edit'),
  Custom: null,
};

const emptyStaffForm = { name: '', email: '', phone: '', jobTitle: '', permissions: [] };

export function StaffManagementPanel({ showSuccess, showError }) {
  const { user, plan } = useAuth();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyStaffForm);
  const [rolePreset, setRolePreset] = useState('Custom');
  const [openGroups, setOpenGroups] = useState(() => new Set(['Students', 'Payments', 'Invoices']));

  const isOwner = (user?.userType || 'owner') === 'owner';
  const planActive = !user?.planExpiry || new Date(user.planExpiry) >= new Date();
  const canManage = isOwner && plan === 'max' && planActive;

  const loadStaff = async () => {
    if (!canManage) return;
    setLoading(true);
    try {
      const res = await axios.get(`${API}/api/staff`);
      setStaff(Array.isArray(res.data) ? res.data : []);
    } catch (e) { showError(e.response?.data?.message || 'Could not load staff'); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadStaff(); }, [canManage]);

  const openAdd = () => {
    setEditing({ mode: 'add' });
    setForm(emptyStaffForm);
    setRolePreset('Custom');
    setOpenGroups(new Set(['Students', 'Payments', 'Invoices']));
  };
  const openEdit = (member) => {
    setEditing({ mode: 'edit', member });
    setForm({
      name: member.name || '',
      email: member.email || '',
      phone: member.phone || '',
      jobTitle: member.jobTitle || '',
      permissions: Array.isArray(member.permissions) ? member.permissions : [],
    });
    setRolePreset('Custom');
    setOpenGroups(new Set(['Students', 'Payments', 'Invoices']));
  };
  const permissionSet = new Set(form.permissions);
  const setPermissions = permissions => setForm(f => ({ ...f, permissions: [...new Set(permissions)] }));
  const applyPreset = (preset) => {
    setRolePreset(preset);
    if (STAFF_ROLE_PRESETS[preset]) setPermissions(STAFF_ROLE_PRESETS[preset]);
  };
  const togglePerm = (permission) => {
    setRolePreset('Custom');
    setForm(f => ({
      ...f,
      permissions: f.permissions.includes(permission)
        ? f.permissions.filter(p => p !== permission)
        : [...f.permissions, permission],
    }));
  };
  const toggleGroup = (group) => {
    setRolePreset('Custom');
    const keys = group.permissions.map(([key]) => key);
    const allSelected = keys.every(key => permissionSet.has(key));
    setPermissions(allSelected ? form.permissions.filter(key => !keys.includes(key)) : [...form.permissions, ...keys]);
  };
  const toggleOpenGroup = (title) => {
    setOpenGroups(prev => {
      const next = new Set(prev);
      next.has(title) ? next.delete(title) : next.add(title);
      return next;
    });
  };
  const submitStaff = async () => {
    if (!form.name.trim()) return showError('Full name is required');
    if (!form.email.trim()) return showError('Email is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return showError('Enter a valid staff email address');
    setSaving(true);
    try {
      if (editing?.mode === 'edit') {
        await axios.patch(`${API}/api/staff/${editing.member.id}`, form);
        showSuccess('Staff member updated');
      } else {
        await axios.post(`${API}/api/staff/invite`, form);
        analytics.track('staff_invited', {
          rolePreset,
          permissionCount: form.permissions.length,
        });
        showSuccess('Staff invitation sent');
      }
      setEditing(null);
      await loadStaff();
    } catch (e) { showError(e.response?.data?.message || 'Could not save staff member'); }
    finally { setSaving(false); }
  };
  const disableStaff = async (member) => {
    setSaving(true);
    try {
      await axios.delete(`${API}/api/staff/${member.id}`);
      analytics.track('staff_removed', {
        staffId: member.id,
        status: member.status,
      });
      showSuccess('Staff member disabled');
      await loadStaff();
    } catch (e) { showError(e.response?.data?.message || 'Could not disable staff'); }
    finally { setSaving(false); }
  };
  const resendInvite = async (member) => {
    setSaving(true);
    try {
      await axios.post(`${API}/api/staff/${member.id}/resend-invite`);
      showSuccess('Invite resent');
      await loadStaff();
    } catch (e) { showError(e.response?.data?.message || 'Could not resend invite'); }
    finally { setSaving(false); }
  };
  const fmtDate = value => value ? new Date(value).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const statusStyle = status => ({
    invited: { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.25)', color: '#60a5fa' },
    active: { bg: 'rgba(34,211,164,0.12)', border: 'rgba(34,211,164,0.25)', color: '#22d3a4' },
    disabled: { bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.24)', color: '#f87171' },
  }[status] || { bg: 'var(--surface2)', border: 'var(--border)', color: 'var(--text2)' });

  if (!canManage) return null;

  return (
    <div className="settings-fields">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <div>
          <div className="branding-title">Staff list</div>
          <div className="branding-help">Staff use their own login and can only access the permissions you grant.</div>
        </div>
        <button className="settings-save-btn" style={{ width: 'auto' }} onClick={openAdd}>Add Staff</button>
      </div>
      <div className="card-body-flush" style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        {loading ? <div style={{ padding: 22, color: 'var(--text3)', fontSize: 13 }}>Loading staff…</div>
          : staff.length === 0 ? <div style={{ padding: 22, color: 'var(--text3)', fontSize: 13 }}>No staff members yet.</div>
          : staff.map(member => (
            <div key={member.id} style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '1.5fr 1.4fr 1fr', gap: 12, alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{member.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>{member.jobTitle || 'Staff'} · {member.phone || 'No phone'}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 2 }}>{member.email}</div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>
                <span style={{ padding: '4px 10px', borderRadius: 20, background: statusStyle(member.status).bg, border: `1px solid ${statusStyle(member.status).border}`, color: statusStyle(member.status).color, fontWeight: 800, textTransform: 'capitalize' }}>{member.status}</span>
                <div style={{ marginTop: 6 }}>Last login: {fmtDate(member.lastLoginAt)}</div>
                <div>Invite expiry: {fmtDate(member.inviteExpiresAt)}</div>
                <div style={{ marginTop: 6 }}>{(member.permissions || []).length} permission{(member.permissions || []).length === 1 ? '' : 's'}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {member.status === 'invited' && <button className="btn btn-outline btn-sm" disabled={saving} onClick={() => resendInvite(member)}>Resend invite</button>}
                <button className="btn btn-outline btn-sm" onClick={() => openEdit(member)}>Edit permissions</button>
                <button className="btn btn-outline btn-sm" disabled={saving || member.status === 'disabled'} onClick={() => disableStaff(member)}>Disable/remove staff</button>
              </div>
            </div>
          ))}
      </div>

      {editing && (
        <>
          <div className="modal-backdrop" onClick={() => setEditing(null)} />
          <div className="settings-modal staff-editor-modal" style={{ maxWidth: 900, width: 'min(900px, calc(100vw - 24px))', maxHeight: '85vh', zIndex: 80, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="settings-header" style={{ flex: '0 0 auto' }}>
              <div>
                <div className="settings-title">{editing.mode === 'edit' ? 'Edit Staff Member' : 'Add Staff Member'}</div>
                <div className="settings-sub">Set up a separate staff login with clear access controls.</div>
              </div>
              <button className="modal-close" onClick={() => setEditing(null)}>x</button>
            </div>
            <div className="settings-body" style={{ flex: '1 1 auto', overflowY: 'auto', padding: 24 }}>
              <div className="settings-fields" style={{ gap: 22 }}>
                <div className="staff-form-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
                  <div className="field-group"><label className="settings-label">Full name</label><input className="settings-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Amina Otieno" /></div>
                  <div className="field-group"><label className="settings-label">Email</label><input className="settings-input" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="staff@school.ac.ke" /></div>
                  <div className="field-group"><label className="settings-label">Phone</label><input className="settings-input" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="07XX XXX XXX" /></div>
                  <div className="field-group"><label className="settings-label">Job title</label><input className="settings-input" value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} placeholder="Accountant, Receptionist..." /></div>
                </div>
                <div className="field-group">
                  <label className="settings-label">Role preset</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {Object.keys(STAFF_ROLE_PRESETS).map(preset => (
                      <button key={preset} type="button" onClick={() => applyPreset(preset)}
                        style={{ padding: '9px 13px', borderRadius: 9, border: `1px solid ${rolePreset === preset ? 'var(--green-border)' : 'var(--border)'}`, background: rolePreset === preset ? 'var(--green-bg)' : 'var(--surface2)', color: rolePreset === preset ? 'var(--green)' : 'var(--text2)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                        {preset}
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>{form.permissions.length} permission{form.permissions.length === 1 ? '' : 's'} selected.</div>
                </div>
                <div className="field-group">
                  <label className="settings-label">Permissions</label>
                  <div style={{ display: 'grid', gap: 12 }}>
                    {STAFF_PERMISSION_GROUPS.map(group => {
                      const keys = group.permissions.map(([key]) => key);
                      const selectedCount = keys.filter(key => permissionSet.has(key)).length;
                      const allSelected = selectedCount === keys.length;
                      const isOpen = openGroups.has(group.title);
                      return (
                        <div key={group.title} style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface2)', overflow: 'hidden' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 16px', cursor: 'pointer' }} onClick={() => toggleOpenGroup(group.title)}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>{group.title}</span>
                                <span style={{ fontSize: 11, color: 'var(--text3)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px' }}>{selectedCount}/{keys.length}</span>
                              </div>
                              <div style={{ fontSize: 12.5, color: 'var(--text3)', marginTop: 4 }}>{group.desc}</div>
                            </div>
                            <label onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text2)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                              <input type="checkbox" checked={allSelected} onChange={() => toggleGroup(group)} style={{ width: 18, height: 18, accentColor: '#22d3a4' }} />
                              Select all
                            </label>
                            <span style={{ color: 'var(--text3)', fontSize: 18, width: 20, textAlign: 'center' }}>{isOpen ? '-' : '+'}</span>
                          </div>
                          {isOpen && (
                            <div style={{ padding: '0 16px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
                              {group.permissions.map(([permission, label]) => (
                                <label key={permission} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '11px 12px', border: '1px solid var(--border)', borderRadius: 10, background: permissionSet.has(permission) ? 'rgba(34,211,164,0.08)' : 'var(--surface)', color: 'var(--text2)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                                  <input type="checkbox" checked={permissionSet.has(permission)} onChange={() => togglePerm(permission)} style={{ width: 18, height: 18, accentColor: '#22d3a4', flexShrink: 0 }} />
                                  {label}
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ flex: '0 0 auto', position: 'sticky', bottom: 0, padding: '15px 24px', borderTop: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>{editing.mode === 'edit' ? 'Changes apply the next time this staff account uses FeeFlow.' : 'The invite link expires after 48 hours.'}</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button className="btn btn-outline" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
                <button className="btn btn-primary" onClick={submitStaff} disabled={saving}>{saving ? 'Saving...' : editing.mode === 'edit' ? 'Save Changes' : 'Send Invite'}</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── User Settings Modal ───────────────────────────────────────────────────────
function UserSettingsModal({ onClose }) {
  const { user, plan, updateUser, refreshUser, logout, theme, toggleTheme, hasPermission } = useAuth();
  const navigate   = useNavigate();
  const resetStore = useAppStore(s => s.reset);

  const [tab,     setTab]     = useState('profile');
  const [saving,  setSaving]  = useState(false);
  const [success, setSuccess] = useState('');
  const [error,   setError]   = useState('');
  const [supportMessage, setSupportMessage] = useState('');
  const [supportLoading, setSupportLoading] = useState(false);
  const [showBillingModal, setShowBillingModal] = useState(false);

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
  const [mpesaCallbackUrls, setMpesaCallbackUrls] = useState(null);
  const [bankPaybillForm, setBankPaybillForm] = useState({
    bankPaybillNumber: user?.bankPaybillNumber || '',
    bankAccountNumber: user?.bankAccountNumber || '',
    bankAccountName: user?.bankAccountName || '',
    bankName: user?.bankName || '',
    bankPaymentInstructions: user?.bankPaymentInstructions || '',
  });
  const [notificationSettings, setNotificationSettings] = useState({
    whatsappEnabled: Boolean(user?.whatsappEnabled),
  });
  const logoInputRef = useRef(null);
  const [branding, setBranding] = useState({
    schoolLogoUrl: user?.schoolLogoUrl || '',
  });
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoPreviewFailed, setLogoPreviewFailed] = useState(false);

  const canEditSettings = hasPermission('settings.edit');
  const canManageMpesa = hasPermission('mpesa.edit');
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
    if (id === 'support') setSupportMessage('');
  };

  const sendSupportRequest = async () => {
    if (!supportMessage.trim() || supportMessage.trim().length < 10) {
      return showError('Please describe your issue with at least 10 characters.');
    }
    setSupportLoading(true);
    try {
      await axios.post(`${API}/api/support/authenticated`, { message: supportMessage.trim() });
      analytics.track('support_request_submitted', {
        source: 'authenticated_settings',
        messageLength: supportMessage.trim().length,
      });
      setSupportMessage('');
      showSuccess('Support request sent. We will follow up by email soon.');
    } catch (e) {
      showError(e.response?.data?.message || 'Could not send your support request. Please try again.');
    } finally {
      setSupportLoading(false);
    }
  };

  const loadMpesaCallbackUrls = async ({ silent = true } = {}) => {
    try {
      const res = await axios.get(`${API}/api/settings/mpesa-callback-urls`);
      setMpesaCallbackUrls(res.data);
      return res.data;
    } catch (e) {
      setMpesaCallbackUrls(null);
      if (!silent) showError(e.response?.data?.message || 'Could not load M-Pesa callback URLs');
      return null;
    }
  };

  const copyCallbackUrl = async (url) => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showSuccess('Callback URL copied');
    } catch {
      showError('Could not copy. Select the URL and copy it manually.');
    }
  };

  useEffect(() => {
    setBranding({ schoolLogoUrl: user?.schoolLogoUrl || '' });
    setLogoPreviewFailed(false);
    setBankPaybillForm({
      bankPaybillNumber: user?.bankPaybillNumber || '',
      bankAccountNumber: user?.bankAccountNumber || '',
      bankAccountName: user?.bankAccountName || '',
      bankName: user?.bankName || '',
      bankPaymentInstructions: user?.bankPaymentInstructions || '',
    });
    setNotificationSettings({ whatsappEnabled: Boolean(user?.whatsappEnabled) });
  }, [
    user?.schoolLogoUrl,
    user?.bankPaybillNumber,
    user?.bankAccountNumber,
    user?.bankAccountName,
    user?.bankName,
    user?.bankPaymentInstructions,
    user?.whatsappEnabled,
  ]);

  useEffect(() => {
    if (tab === 'mpesa' && plan !== 'free' && mpesaConfigured) {
      loadMpesaCallbackUrls({ silent: true });
    }
  }, [tab, plan, mpesaConfigured]);

  const saveProfile = async () => {
    if (!canEditSettings) return showError('You do not have permission to update profile settings.');
    setSaving(true);
    try {
      const res = await axios.patch(`${API}/api/auth/profile`, profile);
      updateUser(res.data);
      showSuccess('Profile updated successfully');
    } catch (e) { showError(e.response?.data?.message || 'Failed to update'); }
    finally { setSaving(false); }
  };

  const saveEmail = async () => {
    if (!canEditSettings) return showError('You do not have permission to update email settings.');
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
    if (!canManageMpesa) return showError('You do not have permission to manage M-Pesa credentials.');
    if (!mpesaForm.consumerKey.trim() || !mpesaForm.consumerSecret.trim() || !mpesaForm.shortcode.trim() || !mpesaForm.passkey.trim()) {
      return showError('All M-Pesa fields are required');
    }
    setSaving(true);
    try {
      await axios.patch(`${API}/api/auth/mpesa`, mpesaForm);
      setMpesaConfigured(true);
      await loadMpesaCallbackUrls({ silent: true });
      setMpesaForm({ consumerKey: '', consumerSecret: '', shortcode: '', passkey: '' });
      analytics.track('mpesa_configuration_completed');
      showSuccess('M-Pesa credentials saved successfully');
    } catch (e) { showError(e.response?.data?.message || 'Failed to save credentials'); }
    finally { setSaving(false); }
  };

  const saveBankPaybill = async () => {
    if (!canManageMpesa) return showError('You do not have permission to manage Bank / Paybill info.');
    setSaving(true);
    try {
      const res = await axios.patch(`${API}/api/auth/bank-paybill`, bankPaybillForm);
      if (res.data?.user) updateUser(res.data.user);
      analytics.track('bank_configuration_completed', {
        hasPaybill: Boolean(bankPaybillForm.bankPaybillNumber),
        hasBankName: Boolean(bankPaybillForm.bankName),
      });
      showSuccess('Bank / Paybill info saved successfully');
    } catch (e) { showError(e.response?.data?.message || 'Failed to save Bank / Paybill info'); }
    finally { setSaving(false); }
  };

  const updateNotificationSetting = async (key, value) => {
    if (!canEditSettings) return showError('You do not have permission to update notification settings.');
    setNotificationSettings(prev => ({ ...prev, [key]: value }));
    setSaving(true);
    try {
      const res = await axios.patch(`${API}/api/settings/notifications`, { [key]: value });
      if (res.data?.user) updateUser(res.data.user);
      showSuccess('Notification settings updated');
    } catch (e) {
      setNotificationSettings(prev => ({ ...prev, [key]: !value }));
      showError(e.response?.data?.message || 'Could not update notification settings');
    } finally { setSaving(false); }
  };

  const syncPlan = async () => {
    setSaving(true);
    try {
      const fresh = await refreshUser();
      showSuccess(`Plan refreshed: ${(fresh?.plan || 'free').toUpperCase()}`);
    } catch (e) { showError(e.response?.data?.message || 'Could not refresh plan'); }
    finally { setSaving(false); }
  };

  const uploadLogo = async (file) => {
    if (!canEditSettings) return showError('You do not have permission to update school branding.');
    if (!file) return;
    setLogoBusy(true);
    const form = new FormData();
    form.append('logo', file);
    try {
      const res = await axios.post(`${API}/api/settings/logo`, form);
      setBranding(b => ({ ...b, schoolLogoUrl: res.data.branding?.schoolLogoUrl || '' }));
      setLogoPreviewFailed(false);
      if (res.data.user) updateUser(res.data.user);
      await refreshUser({ silent: true });
      showSuccess('School logo uploaded');
    } catch (e) { showError(e.response?.data?.message || 'Logo upload failed'); }
    finally {
      setLogoBusy(false);
      if (logoInputRef.current) logoInputRef.current.value = '';
    }
  };

  const removeLogo = async () => {
    if (!canEditSettings) return showError('You do not have permission to update school branding.');
    setLogoBusy(true);
    try {
      const res = await axios.delete(`${API}/api/settings/logo`);
      setBranding(b => ({ ...b, schoolLogoUrl: '' }));
      setLogoPreviewFailed(false);
      if (res.data.user) updateUser(res.data.user);
      await refreshUser({ silent: true });
      showSuccess('School logo removed');
    } catch (e) { showError(e.response?.data?.message || 'Could not remove logo'); }
    finally { setLogoBusy(false); }
  };

  const pm  = PLAN_META[plan] || PLAN_META.free;
  const inp = 'settings-input';
  const lbl = 'settings-label';

  const tabs = [
    { id: 'profile',  label: 'Profile'  },
    ...(canEditSettings ? [{ id: 'email', label: 'Email' }] : []),
    { id: 'password', label: 'Password' },
    { id: 'plan',     label: 'Plan'     },
    ...(canEditSettings ? [{ id: 'notifications', label: 'Notifications' }] : []),
    ...(canManageMpesa ? [{ id: 'mpesa', label: 'M-Pesa' }] : []),
    { id: 'display',  label: 'Display'  },
    { id: 'support',  label: 'Support'  },
  ];

  // Support tab content renderer
  const renderSupportTab = () => (
    <div className="settings-fields">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>Contact Support</div>
        <div style={{ fontSize: 13, color: 'var(--text3)' }}>Write your complaint, feedback, or review...</div>
        <div>
          <textarea className="form-input" rows={6} value={supportMessage} onChange={e => setSupportMessage(e.target.value)} placeholder="Write your complaint, feedback, or review..." />
        </div>
        {error && <div className="settings-error">✕ {error}</div>}
        {success && <div className="settings-success">✓ {success}</div>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{ fontSize: 13 }}>Immediate support</div>
            <div style={{ fontSize: 13, color: 'var(--text3)' }}>
              <div>Call: <a href="tel:+254701475742" style={{ color: 'var(--accent)' }}>+254 701475742</a></div>
              <div>Email: <a href="mailto:feeflow254@gmail.com" style={{ color: 'var(--accent)' }}>feeflow254@gmail.com</a></div>
            </div>
          </div>
          <div>
            <button className="settings-save-btn" onClick={sendSupportRequest} disabled={supportLoading}>
              {supportLoading ? 'Sending…' : 'Send Message'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

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
                  onChange={e => canEditSettings && setProfile(p => ({ ...p, name: e.target.value }))}
                  placeholder="Your name"
                  disabled={!canEditSettings} />
              </div>
              <div className="field-group">
                <label className={lbl}>Phone number</label>
                <input className={inp} type="tel" value={profile.phone}
                  onChange={e => canEditSettings && setProfile(p => ({ ...p, phone: e.target.value }))}
                  placeholder="07XX XXX XXX"
                  disabled={!canEditSettings} />
              </div>
              <div className="field-group">
                <label className={lbl}>School / Institution name</label>
                <input className={inp} value={profile.schoolName}
                  onChange={e => canEditSettings && setProfile(p => ({ ...p, schoolName: e.target.value }))}
                  placeholder="Sunrise High School"
                  disabled={!canEditSettings} />
              </div>
              <div className="branding-panel">
                <div className="branding-logo-preview">
                  {branding.schoolLogoUrl && !logoPreviewFailed ? (
                    <img src={assetUrl(branding.schoolLogoUrl)} alt="School logo preview" onError={() => setLogoPreviewFailed(true)} />
                  ) : (
                    <span>{(profile.schoolName || user?.schoolName || 'S').slice(0, 1).toUpperCase()}</span>
                  )}
                </div>
                <div className="branding-copy">
                  <div className="branding-title">School Logo</div>
                  <div className="branding-help">Recommended 512x512px. PNG, JPG, JPEG, WEBP, SVG. Max 2MB.</div>
                  <div className="branding-actions">
                    <input
                      ref={logoInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/jpg,image/webp,image/svg+xml"
                      style={{ display: 'none' }}
                      onChange={e => canEditSettings && uploadLogo(e.target.files?.[0])}
                    />
                    <button className="settings-save-btn secondary" onClick={() => canEditSettings && logoInputRef.current?.click()} disabled={!canEditSettings || logoBusy}>
                      {logoBusy ? 'Working…' : branding.schoolLogoUrl ? 'Replace logo' : 'Upload logo'}
                    </button>
                    {branding.schoolLogoUrl && canEditSettings && (
                      <button className="settings-save-btn danger-soft" onClick={removeLogo} disabled={logoBusy}>
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {!canEditSettings && (
                <div className="settings-info-box">Only users with Settings Edit permission can update school profile and branding settings.</div>
              )}
              <button className="settings-save-btn" onClick={saveProfile} disabled={!canEditSettings || saving}>
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
                <PasswordInput
                  value={emailForm.password}
                  onChange={e => setEmailForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
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
                <PasswordInput
                  value={pwForm.currentPassword}
                  onChange={e => setPwForm(f => ({ ...f, currentPassword: e.target.value }))}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>
              <div className="field-group">
                <label className={lbl}>New password</label>
                <PasswordInput
                  value={pwForm.newPassword}
                  onChange={e => setPwForm(f => ({ ...f, newPassword: e.target.value }))}
                  placeholder="Min. 6 characters"
                  autoComplete="new-password"
                />
              </div>
              <div className="field-group">
                <label className={lbl}>Confirm new password</label>
                <PasswordInput
                  value={pwForm.confirm}
                  onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
                  placeholder="Repeat new password"
                  autoComplete="new-password"
                />
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
                {plan === 'pro'  && <div className="plan-current-sub">Up to 800 students · M-Pesa + SMS and email invoices</div>}
                {plan === 'max'  && <div className="plan-current-sub">Unlimited students · Full automation + instant receipts</div>}
              </div>
              <button className="settings-save-btn secondary" onClick={syncPlan} disabled={saving}>
                {saving ? 'Refreshing…' : 'Refresh plan status'}
              </button>
              {plan === 'free' && (
                <div className="plan-upgrade-options">
                  <div className="plan-upgrade-card" style={{ borderColor: 'rgba(34,211,164,0.25)' }}>
                    <div className="plan-upgrade-name" style={{ color: '#22d3a4' }}>Pro — KES 20,000/mo</div>
                    <div className="plan-upgrade-feat">800 students · M-Pesa STK Push · SMS and email invoices · Payment reminders</div>
                    <button
                      className="plan-upgrade-btn"
                      style={{ background: '#22d3a4', color: '#0b1a14', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center' }}
                      onClick={() => setShowBillingModal(true)}
                    >
                      Upgrade to Pro — Pay with M-Pesa →
                    </button>
                  </div>
                  <div className="plan-upgrade-card" style={{ borderColor: 'rgba(245,158,11,0.25)' }}>
                    <div className="plan-upgrade-name" style={{ color: '#f59e0b' }}>Max — Custom pricing</div>
                    <div className="plan-upgrade-feat">Unlimited students · Everything in Pro · Instant receipts · Dedicated support</div>
                    <a href="mailto:feeflow254@gmail.com?subject=FeeFlow Max Upgrade" className="plan-upgrade-btn" style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.25)' }}>Contact us →</a>
                  </div>
                </div>
              )}
              {plan !== 'free' && (
                <div className="settings-info-box">
                  To change or cancel your plan, email <a href="mailto:feeflow254@gmail.com" style={{ color: 'var(--accent)' }}>feeflow254@gmail.com</a>
                </div>
              )}
              {showBillingModal && (
                <BillingModal
                  user={user}
                  onClose={() => setShowBillingModal(false)}
                  onSuccess={(freshUser) => {
                    updateUser(freshUser);
                    setShowBillingModal(false);
                    showSuccess('Pro plan activated! Welcome to FeeFlow Pro.');
                  }}
                />
              )}
            </div>
          )}

          {/* -- Notifications -- */}
          {tab === 'notifications' && (
            <div className="settings-fields">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface2)' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minWidth: 0 }}>
                  <div style={{ width: 34, height: 34, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'rgba(37,211,102,0.1)', color: '#25d366', fontSize: 18, flexShrink: 0 }}>💬</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>WhatsApp notifications</div>
                    <div style={{ fontSize: 12.5, color: 'var(--text3)', lineHeight: 1.5, marginTop: 3 }}>Send invoices, auto-receipts, and bank submission alerts via WhatsApp to parents and admins.</div>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={notificationSettings.whatsappEnabled}
                  disabled={saving}
                  onClick={() => updateNotificationSetting('whatsappEnabled', !notificationSettings.whatsappEnabled)}
                  style={{ width: 46, height: 26, borderRadius: 20, border: `1px solid ${notificationSettings.whatsappEnabled ? 'rgba(37,211,102,0.45)' : 'var(--border)'}`, background: notificationSettings.whatsappEnabled ? '#25d366' : 'var(--surface)', padding: 3, cursor: saving ? 'not-allowed' : 'pointer', flexShrink: 0, transition: 'all .15s' }}
                >
                  <span style={{ display: 'block', width: 18, height: 18, borderRadius: '50%', background: notificationSettings.whatsappEnabled ? '#0b1a14' : 'var(--text3)', transform: notificationSettings.whatsappEnabled ? 'translateX(19px)' : 'translateX(0)', transition: 'transform .15s' }} />
                </button>
              </div>
              <div className="settings-info-box">SMS and email delivery continue to work as before. WhatsApp only sends when selected for invoices/manual receipts or enabled here for auto-receipts.</div>
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
                      <a href="#" onClick={e => { e.preventDefault(); setShowBillingModal(true); }}
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
                  <input type="password" style={{ display: 'none' }} autoComplete="current-password" readOnly data-ph-mask />
                  <div className="field-group">
                    <label className={lbl}>Consumer Key</label>
                    <input className={inp} type="password" value={mpesaForm.consumerKey} data-ph-mask
                      onChange={e => setMpesaForm(f => ({ ...f, consumerKey: e.target.value }))}
                      placeholder="From Safaricom Daraja portal"
                      autoComplete="new-password" />
                  </div>
                  <div className="field-group">
                    <label className={lbl}>Consumer Secret</label>
                    <input className={inp} type="password" value={mpesaForm.consumerSecret} data-ph-mask
                      onChange={e => setMpesaForm(f => ({ ...f, consumerSecret: e.target.value }))}
                      placeholder="From Safaricom Daraja portal"
                      autoComplete="new-password" />
                  </div>
                  <div className="field-group">
                    <label className={lbl}>Shortcode (Paybill / Till No.)</label>
                    <input className={inp} value={mpesaForm.shortcode} data-ph-mask
                      onChange={e => setMpesaForm(f => ({ ...f, shortcode: e.target.value }))}
                      placeholder="e.g. 174379" />
                  </div>
                  <div className="field-group">
                    <label className={lbl}>Passkey</label>
                    <input className={inp} type="password" value={mpesaForm.passkey} data-ph-mask
                      onChange={e => setMpesaForm(f => ({ ...f, passkey: e.target.value }))}
                      placeholder="From Safaricom Daraja portal"
                      autoComplete="new-password" />
                  </div>
                  <div className="settings-info-box">
                    Your STK Push callback URL:<br />
                    <code style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--accent)' }}>
                      {`${API}/api/mpesa/callback/${user?.id}`}
                    </code>
                    <br /><br />
                    <div style={{ color: 'var(--text2)', fontSize: 12.5, lineHeight: 1.5 }}>
                      Paste these into your Daraja portal → C2B → Register URLs.
                    </div>
                    {mpesaCallbackUrls ? (
                      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
                        <div>
                          <label className={lbl}>Validation URL</label>
                          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, marginTop: 6 }}>
                            <input className={inp} value={mpesaCallbackUrls.validateUrl || ''} readOnly />
                            <button type="button" className="settings-save-btn secondary" style={{ padding: '0 14px', minHeight: 40 }} onClick={() => copyCallbackUrl(mpesaCallbackUrls.validateUrl)}>
                              Copy
                            </button>
                          </div>
                        </div>
                        <div>
                          <label className={lbl}>Confirmation URL</label>
                          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, marginTop: 6 }}>
                            <input className={inp} value={mpesaCallbackUrls.confirmUrl || ''} readOnly />
                            <button type="button" className="settings-save-btn secondary" style={{ padding: '0 14px', minHeight: 40 }} onClick={() => copyCallbackUrl(mpesaCallbackUrls.confirmUrl)}>
                              Copy
                            </button>
                          </div>
                        </div>
                        {mpesaCallbackUrls.instructions && (
                          <div style={{ fontSize: 11.5, color: 'var(--text3)', lineHeight: 1.45 }}>
                            {mpesaCallbackUrls.instructions}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12.5, color: 'var(--text3)', marginTop: 10 }}>
                        Save your M-Pesa credentials to generate secure C2B callback URLs.
                      </div>
                    )}
                  </div>
                  <button className="settings-save-btn" onClick={saveMpesa} disabled={saving}>
                    {saving ? 'Saving…' : mpesaConfigured ? 'Update credentials' : 'Connect M-Pesa'}
                  </button>
                </>
              )}
              <div style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />
              <div style={{ display: 'grid', gap: 14 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>Bank / Paybill Info</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text3)', marginTop: 4, lineHeight: 1.5 }}>
                    These details are shown to parents on invoice and payment portal links. Leave fields empty if they do not apply.
                  </div>
                </div>
                <div className="field-group">
                  <label className={lbl}>Paybill number</label>
                  <input className={inp} value={bankPaybillForm.bankPaybillNumber}
                    onChange={e => setBankPaybillForm(f => ({ ...f, bankPaybillNumber: e.target.value }))}
                    placeholder="e.g. 123456" />
                </div>
                <div className="field-group">
                  <label className={lbl}>Account number / business number</label>
                  <input className={inp} value={bankPaybillForm.bankAccountNumber}
                    onChange={e => setBankPaybillForm(f => ({ ...f, bankAccountNumber: e.target.value }))}
                    placeholder="e.g. school account number" />
                </div>
                <div className="field-group">
                  <label className={lbl}>Account name / school account name</label>
                  <input className={inp} value={bankPaybillForm.bankAccountName}
                    onChange={e => setBankPaybillForm(f => ({ ...f, bankAccountName: e.target.value }))}
                    placeholder="e.g. Sunrise High School" />
                </div>
                <div className="field-group">
                  <label className={lbl}>Bank name <span style={{ fontWeight: 400, color: 'var(--text3)', textTransform: 'none' }}>(optional)</span></label>
                  <input className={inp} value={bankPaybillForm.bankName}
                    onChange={e => setBankPaybillForm(f => ({ ...f, bankName: e.target.value }))}
                    placeholder="e.g. Equity Bank" />
                </div>
                <div className="field-group">
                  <label className={lbl}>Instructions <span style={{ fontWeight: 400, color: 'var(--text3)', textTransform: 'none' }}>(optional)</span></label>
                  <textarea className={inp} rows={4} value={bankPaybillForm.bankPaymentInstructions}
                    onChange={e => setBankPaybillForm(f => ({ ...f, bankPaymentInstructions: e.target.value }))}
                    placeholder="Any extra narration or confirmation instructions for parents" />
                </div>
                <button className="settings-save-btn" onClick={saveBankPaybill} disabled={saving}>
                  {saving ? 'Saving…' : 'Save Bank / Paybill info'}
                </button>
              </div>
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

          {tab === 'support' && renderSupportTab()}
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
  const { user, token, plan, hasAnyPermission } = useAuth();
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
  const [sidebarLogoFailed, setSidebarLogoFailed] = useState(false);
  const pm = PLAN_META[plan] || PLAN_META.free;
  const schoolLogo = assetUrl(user?.schoolLogoUrl);

  // Support state for settings tab
  const [supportMessage, setSupportMessage] = useState('');
  const [supportLoading, setSupportLoading] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  const showError = (msg) => { setError(msg); setSuccess(''); };
  const showSuccess = (msg) => { setSuccess(msg); setError(''); };

  const sendSupportRequest = async () => {
    setError(''); setSuccess('');
    const trimmed = (supportMessage || '').trim();
    if (!trimmed || trimmed.length < 10) return showError('Please describe your issue in at least 10 characters.');
    setSupportLoading(true);
    try {
      const res = await axios.post(`${API}/api/support/authenticated`, { message: trimmed });
      if (res?.data?.ok) {
        showSuccess('Thank you. Your message has been received. Our team will contact you soon.');
        setSupportMessage('');
      } else {
        showError(res?.data?.message || 'Could not send your message.');
      }
    } catch (e) {
      showError(e.response?.data?.message || 'Could not send your message.');
    } finally { setSupportLoading(false); }
  };

  useEffect(() => {
    setSidebarLogoFailed(false);
  }, [schoolLogo]);

  useEffect(() => {
    const syncSidebarMode = () => {
      if (window.innerWidth < 1024) setCollapsed(false);
    };
    syncSidebarMode();
    window.addEventListener('resize', syncSidebarMode);
    return () => window.removeEventListener('resize', syncSidebarMode);
  }, []);

  // ── Auth guard — redirect to login if token is missing or was cleared ──────
  // Handles: inactivity logout, 401 auto-logout, manual logout from another tab.
  useEffect(() => {
    if (!token) navigate('/', { replace: true });
  }, [token, navigate]);

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

  const canAccessStaffManagement = (user?.userType || 'owner') !== 'staff'
    && plan === 'max'
    && (!user?.planExpiry || new Date(user.planExpiry) >= new Date());

  const canAccessAdmin = (user?.userType || 'owner') !== 'staff' && !!user?.isPlatformAdmin;

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
    canAccessStaffManagement && {
      path: '/staff-management', label: 'Staff Management',
      icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-4-4h-1M9 20H2v-2a4 4 0 014-4h3m4-8a4 4 0 11-8 0 4 4 0 018 0zm6 2v6m3-3h-6"/></svg>,
    },
    canAccessAdmin && {
      path: '/admin', label: 'Admin',
      icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>,
    },
  ].filter(item => {
    if (!item) return false;
    if (item.path === '/students') return hasAnyPermission(['students.view']);
    if (item.path === '/payments') return hasAnyPermission(['payments.view', 'reports.view']);
    if (item.path === '/invoices') return hasAnyPermission(['invoices.view', 'receipts.view']);
    return true;
  });

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
            <div className={`user-avatar${schoolLogo && !sidebarLogoFailed ? ' has-logo' : ''}`} style={{ flexShrink: 0 }}>
              {schoolLogo && !sidebarLogoFailed ? (
                <img src={schoolLogo} alt="" onError={() => setSidebarLogoFailed(true)} />
              ) : (
                (user?.name || 'U').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
              )}
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
