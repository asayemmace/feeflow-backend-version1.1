import { useNavigate } from 'react-router-dom';
import Topbar from '../components/TopBar';

export default function AccessDenied() {
  const navigate = useNavigate();

  return (
    <>
      <Topbar title="Access denied" sub="You do not have permission to view this page." />
      <div className="page-content" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center', maxWidth: 520, padding: 24, borderRadius: 16, border: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🚫</div>
          <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 10 }}>Access denied</div>
          <div style={{ fontSize: 14, color: 'var(--text3)', marginBottom: 24 }}>You do not have the required permission to access this section. Please contact your school owner or administrator if you believe this is an error.</div>
          <button onClick={() => navigate('/dashboard')} style={{ padding: '10px 18px', borderRadius: 10, background: 'var(--accent)', color: '#0b1a14', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}>
            Back to dashboard
          </button>
        </div>
      </div>
    </>
  );
}
