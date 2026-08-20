import { useState } from 'react';
import axios from 'axios';
import analytics from '../analytics/analytics';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000';

const SupportModal = ({ onClose, authenticated = false, user = {} }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState({ success: '', error: '' });
  const [saving, setSaving] = useState(false);

  const clearForm = () => {
    setName('');
    setEmail('');
    setPhone('');
    setMessage('');
  };

  const handleSubmit = async () => {
    setStatus({ success: '', error: '' });
    const trimmedMessage = message.trim();
    if (!trimmedMessage || trimmedMessage.length < 10) {
      return setStatus({ success: '', error: 'Please describe your issue in at least 10 characters.' });
    }

    if (!authenticated) {
      if (!name.trim()) return setStatus({ success: '', error: 'Your full name is required.' });
      if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return setStatus({ success: '', error: 'Enter a valid email address.' });
      }
      if (!phone.trim() || phone.trim().length < 8) {
        return setStatus({ success: '', error: 'Enter a valid phone number.' });
      }
    }

    setSaving(true);
    try {
      await axios.post(
        `${API}/api/support/${authenticated ? 'authenticated' : 'public'}`,
        authenticated ? { message: trimmedMessage } : {
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          message: trimmedMessage,
        },
      );

      setStatus({ success: 'Support request sent. We will reply to you soon.', error: '' });
      analytics.track('support_request_submitted', {
        source: authenticated ? 'authenticated_modal' : 'public_modal',
        messageLength: trimmedMessage.length,
      });
      clearForm();
    } catch (error) {
      setStatus({ success: '', error: error.response?.data?.message || 'Could not send your request. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-box" role="dialog" aria-modal="true" aria-labelledby="support-modal-title">
        <div className="modal-header">
          <div>
            <div id="support-modal-title" className="modal-title">Contact FeeFlow support</div>
            <div className="modal-sub">Submit a request and our team will reply within one business day.</div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close support form">×</button>
        </div>
        <div style={{ padding: '0 22px 22px' }}>
          <div style={{ marginBottom: 18, fontSize: 13, color: 'var(--text3)', lineHeight: 1.6 }}>
            {authenticated
              ? 'You are signed in as ' + (user.email || 'your account') + '. Your message will be sent with your account context.'
              : 'Describe your question or issue and a member of our team will contact you by email.'}
          </div>

          {!authenticated && (
            <>
              <div className="field-group">
                <label className="form-label">Full name</label>
                <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="Your full name" />
              </div>
              <div className="field-group">
                <label className="form-label">Email address</label>
                <input className="form-input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@school.ac.ke" />
              </div>
              <div className="field-group">
                <label className="form-label">Phone number</label>
                <input className="form-input" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="07XX XXX XXX" />
              </div>
            </>
          )}

          <div className="field-group">
            <label className="form-label">Message</label>
            <textarea
              className="form-input"
              rows={6}
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="How can we help? Describe your issue, feature request or onboarding question."
            />
          </div>

          {status.error && (
            <div className="settings-error" style={{ marginBottom: 12 }}>{status.error}</div>
          )}
          {status.success && (
            <div className="settings-success" style={{ marginBottom: 12 }}>{status.success}</div>
          )}

          <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
            <button className="settings-save-btn secondary" type="button" onClick={onClose}>Close</button>
            <button className="settings-save-btn" type="button" onClick={handleSubmit} disabled={saving}>
              {saving ? 'Sending…' : 'Send request'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default SupportModal;
