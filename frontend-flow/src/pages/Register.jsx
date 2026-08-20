import { useState, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import PasswordInput from '../components/PasswordInput';

const Register = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { startRegistration, verifyRegistrationToken, completeRegistration } = useAuth();
  const [stage, setStage] = useState('email');
  const [form, setForm] = useState({ email: '', name: '', schoolName: '', password: '', confirm: '' });
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState('');

  useEffect(() => {
    const tokenParam = new URLSearchParams(location.search).get('token');
    if (!tokenParam) return;

    setToken(tokenParam);
    setStage('verifying');
    setError('');
    setInfo('Verifying your registration link...');
    setLoading(true);

    verifyRegistrationToken(tokenParam)
      .then((res) => {
        setForm((prev) => ({ ...prev, email: res.email }));
        setStage('complete');
        setInfo('Your registration link is valid. Finish the form to complete your account.');
      })
      .catch((err) => {
        setStage('expired');
        setError(err.response?.data?.message || 'This registration link has expired or is invalid.');
        setInfo('');
      })
      .finally(() => setLoading(false));
  }, [location.search, verifyRegistrationToken]);

  const setField = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleEmailSubmit = async (e) => {
    e?.preventDefault?.();
    if (!form.email.trim()) return setError('Please enter your email address.');
    setError('');
    setInfo('');

    flushSync(() => setLoading(true));
    try {
      await startRegistration(form.email.trim());
      setStage('pending');
      setInfo('Check your email to continue registration.');
      setToken('');
      window.history.replaceState({}, '', '/register');
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to send registration link. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteSubmit = async (e) => {
    e?.preventDefault?.();
    if (!canSubmit) return;
    setError('');

    if (!agreedToTerms) return setError('You must agree to the Terms & Conditions to create an account.');
    if (form.password !== form.confirm) return setError('Passwords do not match');
    if (form.password.length < 6) return setError('Password must be at least 6 characters');
    if (!form.name.trim()) return setError('Please enter your name');

    flushSync(() => setLoading(true));
    try {
      await completeRegistration({ token, name: form.name.trim(), schoolName: form.schoolName.trim(), password: form.password });
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = () => {
    setStage('email');
    setError('');
    setInfo('Enter your email address and we will send a new registration link.');
    setToken('');
    window.history.replaceState({}, '', '/register');
  };

  const canSubmitEmail = form.email.trim() && !loading;
  const canSubmit = form.name.trim() && form.password && form.confirm && agreedToTerms && !loading;

  const title = stage === 'complete' ? 'Create your account'
    : stage === 'pending' ? 'Check your email'
    : stage === 'expired' ? 'Registration link expired'
    : 'Verify your email';

  const subtitle = stage === 'complete'
    ? 'Finish registration after email verification.'
    : stage === 'pending'
      ? 'A secure link has been sent to your email address.'
      : stage === 'expired'
        ? 'Send a new link to continue registration.'
        : 'We’ll send you a secure link to continue registration.';

  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <div className="auth-header">
          <div className="auth-logo-wrap">
            <svg fill="none" viewBox="0 0 24 24" stroke="#22d3a4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="26" height="26">
              <path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="auth-title">{title}</div>
          <div className="auth-subtitle">{subtitle}</div>
        </div>

        {error && <div className="error-box">{error}</div>}
        {info && !error && <div className="info-box">{info}</div>}

        <div className="form-group">
          {stage === 'verifying' && (
            <div style={{ padding: '24px 16px', color: 'var(--text2, rgba(255,255,255,0.7))', fontSize: 15 }}>
              Verifying your registration link. Please wait...
            </div>
          )}

          {stage === 'complete' && (
            <>
              <div className="field-group">
                <label className="form-label">Email address</label>
                <input
                  className="form-input"
                  type="email"
                  autoComplete="email"
                  value={form.email}
                  readOnly
                  disabled
                />
              </div>

              <div className="field-group">
                <label className="form-label">Your name</label>
                <input
                  className="form-input"
                  type="text"
                  autoComplete="name"
                  placeholder="Jane Wanjiku"
                  value={form.name}
                  onChange={setField('name')}
                />
              </div>

              <div className="field-group">
                <label className="form-label">School name</label>
                <input
                  className="form-input"
                  type="text"
                  autoComplete="organization"
                  placeholder="Sunrise High School"
                  value={form.schoolName}
                  onChange={setField('schoolName')}
                />
              </div>

              <div className="field-group">
                <label className="form-label">Password</label>
                <PasswordInput
                  autoComplete="new-password"
                  placeholder="Min. 6 characters"
                  value={form.password}
                  onChange={setField('password')}
                />
              </div>

              <div className="field-group">
                <label className="form-label">Confirm password</label>
                <PasswordInput
                  autoComplete="new-password"
                  placeholder="Repeat password"
                  value={form.confirm}
                  onChange={setField('confirm')}
                  onKeyDown={(e) => e.key === 'Enter' && canSubmit && handleCompleteSubmit(e)}
                />
              </div>

              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                padding: '14px 16px',
                background: agreedToTerms ? 'rgba(34,211,164,0.05)' : 'rgba(255,255,255,0.02)',
                border: `1px solid ${agreedToTerms ? 'rgba(34,211,164,0.2)' : 'var(--border, rgba(255,255,255,0.08))'}`,
                borderRadius: 10,
                cursor: 'pointer',
                transition: 'all .2s',
              }} onClick={() => setAgreedToTerms((a) => !a)}>
                <div style={{
                  width: 20, height: 20, borderRadius: 5, flexShrink: 0, marginTop: 1,
                  border: `2px solid ${agreedToTerms ? '#22d3a4' : 'rgba(255,255,255,0.2)'}`,
                  background: agreedToTerms ? 'rgba(34,211,164,0.15)' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all .2s',
                }}>
                  {agreedToTerms && (
                    <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="#22d3a4" strokeWidth="3.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--text2, rgba(255,255,255,0.6))' }}>
                  I agree to FeeFlow's{' '}
                  <Link
                    to="/terms"
                    target="_blank"
                    onClick={(e) => e.stopPropagation()}
                    style={{ color: '#22d3a4', fontWeight: 600, textDecoration: 'none' }}
                  >Terms & Conditions</Link>
                  {' '}and{' '}
                  <Link
                    to="/privacy"
                    target="_blank"
                    onClick={(e) => e.stopPropagation()}
                    style={{ color: '#22d3a4', fontWeight: 600, textDecoration: 'none' }}
                  >Privacy Policy</Link>
                  , including data protection, M-Pesa key encryption, and billing terms.
                </div>
              </div>

              <button
                className="submit-btn"
                onClick={handleCompleteSubmit}
                disabled={!canSubmit}
              >
                {loading ? 'Completing registration…' : 'Create account →'}
              </button>
            </>
          )}

          {stage === 'email' && (
            <>
              <div className="field-group">
                <label className="form-label">Email address</label>
                <input
                  className="form-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="bursar@school.ke"
                  value={form.email}
                  onChange={setField('email')}
                />
              </div>

              <button
                className="submit-btn"
                onClick={handleEmailSubmit}
                disabled={!canSubmitEmail}
              >
                {loading ? 'Sending link…' : 'Continue'}
              </button>
            </>
          )}

          {stage === 'pending' && (
            <button className="submit-btn" onClick={handleEmailSubmit} disabled={loading}>
              {loading ? 'Sending again…' : 'Resend link'}
            </button>
          )}

          {stage === 'expired' && (
            <button className="submit-btn" onClick={handleRetry}>
              Send a new link
            </button>
          )}
        </div>

        <div className="auth-footer">
          Already have an account?{' '}
          <Link to="/login" className="auth-link">Sign in</Link>
          <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center', gap: 14 }}>
            <Link to="/privacy" className="auth-link">Privacy</Link>
            <Link to="/terms" className="auth-link">Terms</Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Register;
