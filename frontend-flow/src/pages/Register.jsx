import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const Register = () => {
  const navigate = useNavigate();
  const { register, token } = useAuth();
  const [form, setForm]       = useState({ name: '', email: '', schoolName: '', password: '', confirm: '' });
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  // Redirect if already logged in
  useEffect(() => {
    if (token) navigate('/dashboard');
  }, [token, navigate]);

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // Basic validation
    if (form.password !== form.confirm) {
      setError('Passwords do not match');
      return;
    }
    if (form.password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);
    try {
      // Call register from AuthContext
      await register(form.name, form.email, form.password, form.schoolName);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.message || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
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

        <form className="form-group" onSubmit={handleSubmit}>
          <label className="form-label">
            Your name
            <input
              className="form-input"
              type="text"
              placeholder="Jane Wanjiku"
              value={form.name}
              onChange={set('name')}
              required
              autoFocus
            />
          </label>

          <label className="form-label">
            School name
            <input
              className="form-input"
              type="text"
              placeholder="Sunrise High School"
              value={form.schoolName}
              onChange={set('schoolName')}
              required
            />
          </label>

          <label className="form-label">
            Email address
            <input
              className="form-input"
              type="email"
              placeholder="bursar@school.ke"
              value={form.email}
              onChange={set('email')}
              required
            />
          </label>

          <label className="form-label">
            Password
            <input
              className="form-input"
              type="password"
              placeholder="Min. 6 characters"
              value={form.password}
              onChange={set('password')}
              required
            />
          </label>

          <label className="form-label">
            Confirm password
            <input
              className="form-input"
              type="password"
              placeholder="Repeat password"
              value={form.confirm}
              onChange={set('confirm')}
              required
            />
          </label>

          <button className="submit-btn" type="submit" disabled={loading}>
            {loading ? 'Creating account…' : 'Create account →'}
          </button>
        </form>

        <div className="auth-footer">
          Already have an account?{' '}
          <Link to="/login" className="auth-link">Sign in</Link>
        </div>
      </div>
    </div>
  );
};

export default Register;
