import { useState } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// ─── Forgot-password sub-component (3 steps inline) ───────────────────────────
const ForgotPassword = ({ onBack }) => {
  const [step, setStep]         = useState('email');   // 'email' | 'code' | 'newpass' | 'done'
  const [email, setEmail]       = useState('');
  const [code, setCode]         = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [error, setError]       = useState('');
  const [info, setInfo]         = useState('');
  const [loading, setLoading]   = useState(false);

  const API = import.meta.env.VITE_API_URL || '';

  const requestCode = async () => {
    if (!email) return setError('Please enter your email address');
    setError(''); setInfo('');
    flushSync(() => setLoading(true));
    try {
      const r = await fetch(`${API}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d.message || 'Something went wrong');
      setInfo('A 6-digit code has been sent to your email (and phone if on file). Check your inbox.');
      setStep('code');
    } catch { setError('Network error. Please try again.'); }
    finally { setLoading(false); }
  };

  const verifyCode = async () => {
    if (!code || code.length !== 6) return setError('Enter the 6-digit code from your email');
    setError('');
    flushSync(() => setLoading(true));
    try {
      const r = await fetch(`${API}/api/auth/verify-reset-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d.message || 'Invalid or expired code');
      setResetToken(d.resetToken);
      setInfo('');
      setStep('newpass');
    } catch { setError('Network error. Please try again.'); }
    finally { setLoading(false); }
  };

  const resetPassword = async () => {
    if (!newPassword || newPassword.length < 6) return setError('Password must be at least 6 characters');
    if (newPassword !== confirmPass) return setError('Passwords do not match');
    setError('');
    flushSync(() => setLoading(true));
    try {
      const r = await fetch(`${API}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetToken, newPassword }),
      });
      const d = await r.json();
      if (!r.ok) return setError(d.message || 'Something went wrong');
      setStep('done');
    } catch { setError('Network error. Please try again.'); }
    finally { setLoading(false); }
  };

  const handleKeyDown = (e, action) => {
    if (e.key === 'Enter' && !loading) action();
  };

  return (
    <div className="forgot-password-page" style={{ backgroundColor: '#0b0f1a', minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', boxSizing: 'border-box' }}>
      <div className="forgot-password-card" style={{ backgroundColor: '#111827', border: '1px solid #1e2d47', borderRadius: '16px', padding: '36px 32px', width: '100%', maxWidth: '420px', boxSizing: 'border-box' }}>
        <div className="auth-header">
          <div className="auth-logo-wrap">
            <svg fill="none" viewBox="0 0 24 24" stroke="#22d3a4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="26" height="26">
              <path d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </div>
          <div className="auth-title">
            {step === 'email'   && 'Reset password'}
            {step === 'code'    && 'Enter your code'}
            {step === 'newpass' && 'Set new password'}
            {step === 'done'    && 'All done!'}
          </div>
          <div className="auth-subtitle">
            {step === 'email'   && 'Enter your account email to receive a reset code'}
            {step === 'code'    && `We sent a 6-digit code to ${email}`}
            {step === 'newpass' && 'Choose a new password for your account'}
            {step === 'done'    && 'Your password has been updated successfully'}
          </div>
        </div>

        {error && <div className="error-box">{error}</div>}
        {info  && <div className="info-box">{info}</div>}

        {step === 'email' && (
          <div className="form-group">
            <div className="field-group">
              <label className="form-label">Email address</label>
              <input
                className="form-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="Enter your email address"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => handleKeyDown(e, requestCode)}
                style={{ fontSize: '16px' }}
              />
            </div>
            <button className="submit-btn" onClick={requestCode} disabled={loading || !email} style={{ fontSize: '16px', padding: '14px 24px', background: '#22d3a4', borderColor: '#22d3a4', color: '#fff' }}>
              {loading ? 'Sending reset code…' : 'Send reset code'}
            </button>
          </div>
        )}

        {step === 'code' && (
          <div className="form-group">
            <div className="field-group">
              <label className="form-label">6-digit code</label>
              <input
                className="form-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="Enter 6-digit code"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={e => handleKeyDown(e, verifyCode)}
                style={{ letterSpacing: '0.35em', fontSize: '1.3rem', textAlign: 'center', padding: '12px' }}
              />
            </div>
            <button className="submit-btn" onClick={verifyCode} disabled={loading || code.length !== 6} style={{ fontSize: '16px', padding: '14px 24px', background: '#22d3a4', borderColor: '#22d3a4', color: '#fff' }}>
              {loading ? 'Verifying code…' : 'Verify code'}
            </button>
            <button className="auth-link-btn" onClick={requestCode} disabled={loading} style={{ marginTop: '12px', fontSize: '14px', color: '#22d3a4', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>
              Didn't receive the code? Resend
            </button>
          </div>
        )}

        {step === 'newpass' && (
          <div className="form-group">
            <div className="field-group">
              <label className="form-label">New password</label>
              <input
                className="form-input"
                type="password"
                autoComplete="new-password"
                placeholder="Enter new password (min. 6 characters)"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                onKeyDown={e => handleKeyDown(e, resetPassword)}
                style={{ fontSize: '16px' }}
              />
            </div>
            <div className="field-group">
              <label className="form-label">Confirm password</label>
              <input
                className="form-input"
                type="password"
                autoComplete="new-password"
                placeholder="Confirm your new password"
                value={confirmPass}
                onChange={e => setConfirmPass(e.target.value)}
                onKeyDown={e => handleKeyDown(e, resetPassword)}
                style={{ fontSize: '16px' }}
              />
            </div>
            <button className="submit-btn" onClick={resetPassword} disabled={loading || !newPassword || !confirmPass} style={{ fontSize: '16px', padding: '14px 24px', background: '#22d3a4', borderColor: '#22d3a4', color: '#fff' }}>
              {loading ? 'Updating password…' : 'Update password'}
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="form-group">
            <div style={{ textAlign: 'center', padding: '8px 0 16px' }}>
              <span style={{ fontSize: '2.5rem' }}>✅</span>
              <p style={{ marginTop: '12px', color: 'var(--text-secondary, #666)', fontSize: '0.9rem' }}>
                You can now sign in with your new password.
              </p>
            </div>
            <button className="submit-btn" onClick={onBack} style={{ fontSize: '16px', padding: '14px 24px', background: '#22d3a4', borderColor: '#22d3a4', color: '#fff' }}>
              Back to sign in →
            </button>
          </div>
        )}

        {step !== 'done' && (
          <div className="auth-footer">
            <button className="auth-link-btn" onClick={onBack} style={{ color: '#22d3a4', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}>← Back to sign in</button>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Main Login component ──────────────────────────────────────────────────────
const Login = () => {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [showForgot, setShowForgot] = useState(false);

  if (showForgot) {
    return <ForgotPassword onBack={() => setShowForgot(false)} />;
  }

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (loading || !email || !password) return;
    setError('');
    flushSync(() => setLoading(true));   // paint spinner BEFORE the network call
    try {
      await login(email, password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Invalid email or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <div className="auth-logo-wrap">
            <svg fill="none" viewBox="0 0 24 24" stroke="#22d3a4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="26" height="26">
              <path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
          </div>
          <div className="auth-title">Welcome back</div>
          <div className="auth-subtitle">Sign in to your FeeFlow account</div>
        </div>

        {error && <div className="error-box">{error}</div>}

        {/* Use div + onSubmit shim so iOS "Go" button works without <form> */}
        <div className="form-group">
          <div className="field-group">
            <label className="form-label">Email address</label>
            <input
              className="form-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="bursar@school.ke"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !loading && handleSubmit(e)}
            />
          </div>

          <div className="field-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label className="form-label">Password</label>
              <button
                className="auth-link-btn"
                onClick={() => setShowForgot(true)}
                style={{ fontSize: '0.78rem', background: 'transparent', border: 'none', color: '#22d3a4', cursor: 'pointer', padding: 0 }}
              >
                Forgot password?
              </button>
            </div>
            <input
              className="form-input"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !loading && handleSubmit(e)}
            />
          </div>

          <button
            className="submit-btn"
            onClick={handleSubmit}
            disabled={loading || !email || !password}
          >
            {loading ? 'Signing in…' : 'Sign in →'}
          </button>
        </div>

        <div className="auth-footer">
          Don't have an account?{' '}
          <Link to="/register" className="auth-link">Create one</Link>
        </div>
      </div>
    </div>
  );
};

export default Login;