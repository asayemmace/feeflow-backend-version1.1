import { useState } from 'react';

export default function PasswordInput({
  value,
  onChange,
  placeholder,
  name,
  required,
  autoComplete,
  disabled,
  error,
  ...rest
}) {
  const [visible, setVisible] = useState(false);
  const label = visible ? 'Hide password' : 'Show password';

  return (
    <div className="password-input-wrapper">
      <input
        type={visible ? 'text' : 'password'}
        className={`form-input${error ? ' password-input-error' : ''}`}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        name={name}
        required={required}
        autoComplete={autoComplete}
        disabled={disabled}
        data-ph-mask
        aria-label={placeholder}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error && name ? `${name}-error` : undefined}
        {...rest}
      />
      <button
        type="button"
        className="password-toggle-btn"
        onClick={() => setVisible((current) => !current)}
        aria-label={label}
        onMouseDown={(event) => event.preventDefault()}
      >
        {visible ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-5.05 0-9.27-3.11-11-7.5a10.97 10.97 0 0 1 5.05-5.8" />
            <path d="M1 1l22 22" />
            <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
            <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
      {error && (
        <div id={name ? `${name}-error` : undefined} className="password-error">
          {error}
        </div>
      )}
    </div>
  );
}
