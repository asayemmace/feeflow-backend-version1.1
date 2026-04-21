import { useState } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const Login = () => {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

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
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
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
            <label className="form-label">Password</label>
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