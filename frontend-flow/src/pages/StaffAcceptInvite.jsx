import { useEffect, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { verifyStaffInvite, acceptStaffInvite } from '../api/client';
import PasswordInput from '../components/PasswordInput';
import analytics from '../analytics/analytics';

export default function StaffAcceptInvite() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [inviteInfo, setInviteInfo] = useState(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const inviteToken = params.get('token') || '';
    if (!inviteToken) {
      setStatus('invalid');
      setError('Missing invite token. Please use the link from your invitation email.');
      return;
    }
    setToken(inviteToken);

    const loadInvite = async () => {
      try {
        const data = await verifyStaffInvite(inviteToken);
        setInviteInfo(data);
        setStatus('ready');
      } catch (err) {
        setStatus('invalid');
        setError(err?.response?.data?.message || 'Invalid or expired invitation link.');
      }
    };

    loadInvite();
  }, [location.search]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (password.length < 6) {
      return setError('Password must be at least 6 characters.');
    }
    if (password !== confirmPassword) {
      return setError('Passwords do not match.');
    }
    setError('');
    setStatus('submitting');
    try {
      await acceptStaffInvite({ token, password });
      analytics.track('staff_created', {
        email: inviteInfo?.email || null,
      });
      setSuccessMessage('Your staff account is now active. You can sign in with your email and password.');
      setStatus('complete');
    } catch (err) {
      setStatus('ready');
      setError(err?.response?.data?.message || 'Unable to accept invitation. Please try again.');
    }
  };

  return (
    <div className="auth-page" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', backgroundColor: '#0b0f1a' }}>
      <div style={{ width: '100%', maxWidth: '440px', backgroundColor: '#111827', border: '1px solid #1e2d47', borderRadius: '18px', padding: '34px 32px' }}>
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '28px' }}>Accept staff invitation</h1>
          <p style={{ margin: '10px 0 0', color: '#cbd5e1' }}>
            {inviteInfo ? `Create a password for ${inviteInfo.email}` : 'Complete your staff account setup using the invitation link.'}
          </p>
        </div>

        {error && (
          <div style={{ marginBottom: '20px', padding: '14px 16px', backgroundColor: '#7f1d1d', borderRadius: '12px', color: '#fee2e2' }}>
            {error}
          </div>
        )}

        {status === 'loading' && (
          <div style={{ color: '#cbd5e1' }}>Checking your invitation link...</div>
        )}

        {status === 'invalid' && (
          <div>
            <p style={{ color: '#cbd5e1' }}>The invitation link is not valid or has expired.</p>
            <p style={{ color: '#cbd5e1' }}>If you believe this is an error, ask the inviter to resend your invitation.</p>
            <Link to="/login" style={{ color: '#38bdf8', textDecoration: 'underline' }}>Back to login</Link>
          </div>
        )}

        {status === 'ready' && (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: '#cbd5e1' }}>Password</label>
              <PasswordInput
                placeholder="Enter a new password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={6}
              />
            </div>
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: '#cbd5e1' }}>Confirm password</label>
              <PasswordInput
                placeholder="Confirm your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                minLength={6}
              />
            </div>
            <button
              type="submit"
              disabled={status === 'submitting'}
              style={{
                width: '100%',
                padding: '14px 16px',
                borderRadius: '12px',
                border: 'none',
                backgroundColor: '#0ea5e9',
                color: '#ffffff',
                cursor: status === 'submitting' ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
            >
              {status === 'submitting' ? 'Activating account…' : 'Activate account'}
            </button>
          </form>
        )}

        {status === 'complete' && (
          <div>
            <div style={{ marginBottom: '20px', padding: '14px 16px', backgroundColor: '#064e3b', borderRadius: '12px', color: '#d1fae5' }}>
              {successMessage}
            </div>
            <button
              type="button"
              onClick={() => navigate('/login')}
              style={{
                width: '100%',
                padding: '14px 16px',
                borderRadius: '12px',
                border: 'none',
                backgroundColor: '#0ea5e9',
                color: '#ffffff',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Go to login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
