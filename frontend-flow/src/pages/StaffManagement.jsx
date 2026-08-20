import { useEffect, useState } from 'react';
import { Navigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import Topbar from '../components/TopBar';
import { StaffManagementPanel } from '../layouts/AppLayout';

export default function StaffManagement() {
  const { user, plan } = useAuth();
  const { openSidebar } = useOutletContext();
  const [toast, setToast] = useState(null);

  const canAccess = (user?.userType || 'owner') !== 'staff'
    && plan === 'max'
    && (!user?.planExpiry || new Date(user.planExpiry) >= new Date());

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!canAccess) return <Navigate to="/dashboard" replace />;

  const showSuccess = msg => setToast({ type: 'success', msg });
  const showError = msg => setToast({ type: 'error', msg });

  return (
    <>
      <Topbar
        title="Staff Management"
        sub="Add staff accounts and control what they can access."
        onMenuClick={openSidebar}
      />
      <div className="page-content">
        <StaffManagementPanel showSuccess={showSuccess} showError={showError} />
      </div>

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 100, background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `3px solid ${toast.type === 'error' ? 'var(--danger)' : 'var(--green)'}`, borderRadius: 10, padding: '12px 20px', fontSize: 13, color: 'var(--text)', boxShadow: 'var(--shadow)', display: 'flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap', maxWidth: 'calc(100vw - 32px)', animation: 'fadeUp .2s ease' }}>
          <span style={{ color: toast.type === 'error' ? 'var(--danger)' : 'var(--green)' }}>{toast.type === 'error' ? 'x' : 'OK'}</span>
          {toast.msg}
        </div>
      )}
    </>
  );
}
