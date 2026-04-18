import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const Register = () => {
  const navigate = useNavigate();
  const { register } = useAuth();
  const [form, setForm]       = useState({ name: '', email: '', schoolName: '', password: '', confirm: '' });
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    setError('');

    if (form.password !== form.confirm) return setError('Passwords do not match');
    if (form.password.length < 6)      return setError('Password must be at least 6 characters');
    if (!form.name.trim())             return setError('Please enter your name');
    if (!form.email.trim())            return setError('Please enter your email');

    setLoading(true);
    try {
      await register(form.name.trim(), form.email.trim(), form.password, form.schoolName.trim());
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = form.name && form.email && form.password && form.confirm && !loading;

  return (
    <div className="auth-page">
      {/* slightly wider card for 5-field form, still mobile-safe */}
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <div className="auth-header">
          <div className="auth-logo-wrap">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
          </div>
          <div className="auth-title">Create your account</div>
          <div className="auth-subtitle">Get started with FeeFlow today</div>
        </div>

        {error && <div className="error-box">{error}</div>}

        <div className="form-group">
          <div className="field-group">
            <label className="form-label">Your name</label>
            <input
              className="form-input"
              type="text"
              autoComplete="name"
              placeholder="Jane Wanjiku"
              value={form.name}
              onChange={set('name')}
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
              onChange={set('schoolName')}
            />
          </div>

          <div className="field-group">
            <label className="form-label">Email address</label>
            <input
              className="form-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="bursar@school.ke"
              value={form.email}
              onChange={set('email')}
            />
          </div>

          <div className="field-group">
            <label className="form-label">Password</label>
            <input
              className="form-input"
              type="password"
              autoComplete="new-password"
              placeholder="Min. 6 characters"
              value={form.password}
              onChange={set('password')}
            />
          </div>

          <div className="field-group">
            <label className="form-label">Confirm password</label>
            <input
              className="form-input"
              type="password"
              autoComplete="new-password"
              placeholder="Repeat password"
              value={form.confirm}
              onChange={set('confirm')}
              onKeyDown={e => e.key === 'Enter' && canSubmit && handleSubmit()}
            />
          </div>

          <button
            className="submit-btn"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {loading ? 'Creating account…' : 'Create account →'}
          </button>
        </div>

        <div className="auth-footer">
          Already have an account?{' '}
          <Link to="/login" className="auth-link">Sign in</Link>
        </div>
      </div>
    </div>
  );
};

export default Register;
