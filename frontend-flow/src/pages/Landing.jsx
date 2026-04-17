import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

const LogoIcon = () => (
  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
  </svg>
);

const FEATURES = [
  {
    color: 'var(--green)', bg: 'var(--green-bg)', border: 'var(--green-border)',
    title: 'M-Pesa Integration',
    desc: 'Receive payments directly via M-Pesa Daraja. Every transaction is auto-matched to a student record in real time.',
    icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"/></svg>,
  },
  {
    color: 'var(--blue)', bg: 'var(--blue-bg)', border: 'var(--blue-border)',
    title: 'Automated Invoices',
    desc: 'Generate and send professional PDF invoices to parents over WhatsApp — all triggered automatically via n8n workflows.',
    icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>,
  },
  {
    color: 'var(--amber)', bg: 'var(--amber-bg)', border: 'var(--amber-border)',
    title: 'Smart Reminders',
    desc: 'Automatic 3-day, 1-day, and overdue payment reminders sent directly to parents. Zero manual follow-up required.',
    icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>,
  },
  {
    color: 'var(--green)', bg: 'var(--green-bg)', border: 'var(--green-border)',
    title: 'Student Management',
    desc: 'Track every student\'s fee balance, payment history, and status in one clean dashboard. Export to CSV anytime.',
    icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>,
  },
  {
    color: 'var(--blue)', bg: 'var(--blue-bg)', border: 'var(--blue-border)',
    title: 'Live Analytics',
    desc: 'Real-time collection stats, term-over-term comparisons, and overdue alerts. Know exactly where your fees stand.',
    icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>,
  },
  {
    color: 'var(--amber)', bg: 'var(--amber-bg)', border: 'var(--amber-border)',
    title: 'Fully Managed',
    desc: 'No software to install. We host everything. Your school gets a dedicated account on our secure, always-on platform.',
    icon: <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"/></svg>,
  },
];

const PLANS = [
  {
    name: "Free",
    price: null,
    priceLabel: "KES 0",
    sub: "Always free",
    badge: null,
    accent: "#4a5f80",
    accentBg: "rgba(74,95,128,0.08)",
    accentBorder: "rgba(74,95,128,0.15)",
    cta: "Get started free",
    ctaStyle: "outline",
    features: [
      { text: "Up to 300 students", included: true },
      { text: "Fee balance tracking", included: true },
      { text: "Student database & records", included: true },
      { text: "Manual payment recording", included: true },
      { text: "Basic dashboard", included: true },
      { text: "Term management", included: true },
      { text: "M-Pesa / STK Push integration", included: false },
      { text: "Automatic invoices & receipts", included: false },
      { text: "WhatsApp payment reminders", included: false },
      { text: "Payment tracking & matching", included: false },
    ],
    note: "Perfect for small institutions getting started.",
  },
  {
    name: "Pro",
    price: 20000,
    priceLabel: "KES 20,000",
    sub: "per month",
    badge: "Most popular",
    accent: "#22d3a4",
    accentBg: "rgba(34,211,164,0.08)",
    accentBorder: "rgba(34,211,164,0.2)",
    cta: "Start Pro trial",
    ctaStyle: "primary",
    features: [
      { text: "Up to 800 students", included: true },
      { text: "Fee balance tracking", included: true },
      { text: "Student database & records", included: true },
      { text: "Manual payment recording", included: true },
      { text: "Full dashboard & analytics", included: true },
      { text: "Term management & archives", included: true },
      { text: "M-Pesa STK Push integration", included: true },
      { text: "Automatic invoices via WhatsApp", included: true },
      { text: "Payment reminders (3-day, 1-day, overdue)", included: true },
      { text: "Instant receipt generation", included: false },
    ],
    note: "For growing schools that need full M-Pesa automation.",
  },
  {
    name: "Max",
    price: null,
    priceLabel: "Custom",
    sub: "contact us",
    badge: "Enterprise",
    accent: "#f59e0b",
    accentBg: "rgba(245,158,11,0.08)",
    accentBorder: "rgba(245,158,11,0.2)",
    cta: "Contact us",
    ctaStyle: "amber",
    features: [
      { text: "800+ students (unlimited)", included: true },
      { text: "Fee balance tracking", included: true },
      { text: "Student database & records", included: true },
      { text: "Manual payment recording", included: true },
      { text: "Full dashboard & analytics", included: true },
      { text: "Term management & archives", included: true },
      { text: "M-Pesa STK Push integration", included: true },
      { text: "Automatic invoices via WhatsApp", included: true },
      { text: "Payment reminders (3-day, 1-day, overdue)", included: true },
      { text: "Instant receipt generation on demand", included: true },
      { text: "Priority support & onboarding", included: true },
      { text: "Dedicated account manager", included: true },
    ],
    note: "For large institutions that need everything + priority support.",
  },
];

const CheckIcon = ({ color }) => (
  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke={color || "#22d3a4"} strokeWidth="2.5" style={{ flexShrink: 0, marginTop: 1 }}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
  </svg>
);

const XIcon = () => (
  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="var(--text3)" strokeWidth="2.5" style={{ flexShrink: 0, marginTop: 1, opacity: 0.5 }}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
  </svg>
);

const Landing = () => {
  const navigate = useNavigate();
  const { token } = useAuth();

  useEffect(() => {
    if (token) navigate('/dashboard');
  }, [token, navigate]);

  return (
    <div className="landing">
      {/* Nav */}
      <nav className="landing-nav">
        <div className="landing-nav-logo">
          <div className="landing-nav-logo-mark"><LogoIcon /></div>
          <div className="landing-nav-logo-text">FeeFlow</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <a href="#pricing" style={{ fontSize: 13.5, color: 'var(--text2)', textDecoration: 'none', fontWeight: 500 }}
            onClick={(e) => { e.preventDefault(); document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' }); }}>
            Pricing
          </a>
          <div className="landing-nav-actions">
            <button className="btn btn-outline" onClick={() => navigate('/login')}>Sign in</button>
            <button className="btn btn-primary" onClick={() => navigate('/register')}>Get started</button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="landing-hero">
        <div className="landing-tag">
          <span style={{ width: 7, height: 7, background: 'var(--green)', borderRadius: '50%', display: 'inline-block' }} />
          Built for Kenyan schools
        </div>
        <h1 className="landing-h1">
          School fee management<br />
          <span>without the chaos.</span>
        </h1>
        <p className="landing-sub">
          FeeFlow automates M-Pesa collection, invoice delivery, and payment reminders
          — so bursars spend less time chasing fees.
        </p>
        <div className="landing-ctas">
          <button className="landing-cta-primary" onClick={() => navigate('/register')}>
            Start free trial →
          </button>
          <button className="landing-cta-secondary" onClick={() => navigate('/login')}>
            Sign into your account
          </button>
        </div>
      </section>

      {/* Stats */}
      <div className="landing-stats">
        {[
          { val: 'KES 2.4M', lbl: 'Collected per term' },
          { val: '542+',     lbl: 'Students tracked' },
          { val: '86%',      lbl: 'Collection rate' },
          { val: '<2 min',   lbl: 'Invoice delivery time' },
        ].map(s => (
          <div key={s.lbl} style={{ textAlign: 'center' }}>
            <div className="landing-stat-val">{s.val}</div>
            <div className="landing-stat-lbl">{s.lbl}</div>
          </div>
        ))}
      </div>

      {/* Features */}
      <section className="landing-features">
        <div className="landing-section-label">Why FeeFlow</div>
        <h2 className="landing-h2">Everything your bursar needs</h2>
        <div className="features-grid">
          {FEATURES.map(f => (
            <div className="feature-card" key={f.title}>
              <div className="feature-icon" style={{ background: f.bg, border: `1px solid ${f.border}` }}>
                <svg style={{ width: 20, height: 20, color: f.color, strokeWidth: 1.8 }}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  {f.icon.props.children}
                </svg>
              </div>
              <div className="feature-title">{f.title}</div>
              <div className="feature-desc">{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Pricing ─────────────────────────────────────────────────────────── */}
      <section id="pricing" style={{
        padding: '80px 24px',
        maxWidth: 1100,
        margin: '0 auto',
      }}>
        <div className="landing-section-label" style={{ textAlign: 'center' }}>Pricing</div>
        <h2 className="landing-h2" style={{ textAlign: 'center', marginBottom: 12 }}>
          Simple, transparent plans
        </h2>
        <p style={{
          textAlign: 'center', color: 'var(--text2)', fontSize: 14,
          maxWidth: 480, margin: '0 auto 52px', lineHeight: 1.7,
        }}>
          Start free and upgrade when you're ready. No hidden fees, no contracts.
          All plans include a free account and full access to the dashboard.
        </p>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 20,
        }}>
          {PLANS.map((plan) => {
            const isPopular = plan.badge === 'Most popular';
            return (
              <div
                key={plan.name}
                style={{
                  background: isPopular
                    ? 'linear-gradient(160deg, var(--surface2) 60%, var(--surface))'
                    : 'var(--surface)',
                  border: `1px solid ${isPopular ? plan.accentBorder : 'var(--border)'}`,
                  borderRadius: 16,
                  padding: '28px 24px',
                  position: 'relative',
                  boxShadow: isPopular ? `0 0 0 1px ${plan.accentBorder}, 0 20px 40px rgba(0,0,0,0.15)` : 'none',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {/* Badge */}
                {plan.badge && (
                  <div style={{
                    position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
                    fontSize: 10.5, fontWeight: 700, padding: '4px 12px', borderRadius: 20,
                    background: plan.accent, color: '#0b1a14',
                    letterSpacing: 0.8, textTransform: 'uppercase', whiteSpace: 'nowrap',
                  }}>{plan.badge}</div>
                )}

                {/* Plan name */}
                <div style={{
                  fontSize: 12, fontWeight: 700, color: plan.accent,
                  textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 12,
                }}>{plan.name}</div>

                {/* Price */}
                <div style={{ marginBottom: 6 }}>
                  <span style={{
                    fontFamily: "'DM Serif Display',serif",
                    fontSize: 36, fontWeight: 400, color: 'var(--text)', letterSpacing: -1,
                  }}>{plan.priceLabel}</span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 24 }}>{plan.sub}</div>

                {/* CTA */}
                <button
                  onClick={() => plan.ctaStyle === 'amber'
                    ? window.location.href = 'mailto:yahiawarsame@gmail.com?subject=FeeFlow Max Plan'
                    : navigate('/register')}
                  style={{
                    width: '100%', padding: '10px 0', borderRadius: 9,
                    fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    fontFamily: "'DM Sans',sans-serif", marginBottom: 24,
                    border: plan.ctaStyle === 'outline' ? `1px solid var(--border)` : 'none',
                    background: plan.ctaStyle === 'primary' ? '#22d3a4'
                      : plan.ctaStyle === 'amber' ? 'rgba(245,158,11,0.1)'
                      : 'transparent',
                    color: plan.ctaStyle === 'primary' ? '#0b1a14'
                      : plan.ctaStyle === 'amber' ? '#f59e0b'
                      : 'var(--text2)',
                  }}
                >{plan.cta}</button>

                {/* Divider */}
                <div style={{ borderTop: '1px solid var(--border)', marginBottom: 20 }} />

                {/* Features */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 11, flex: 1 }}>
                  {plan.features.map((f) => (
                    <div key={f.text} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      {f.included ? <CheckIcon color={plan.accent} /> : <XIcon />}
                      <span style={{
                        fontSize: 13, color: f.included ? 'var(--text2)' : 'var(--text3)',
                        lineHeight: 1.5,
                      }}>{f.text}</span>
                    </div>
                  ))}
                </div>

                {/* Note */}
                <div style={{
                  marginTop: 20, fontSize: 11.5, color: 'var(--text3)',
                  padding: '10px 12px', borderRadius: 8,
                  background: plan.accentBg, border: `1px solid ${plan.accentBorder}`,
                  lineHeight: 1.6,
                }}>{plan.note}</div>
              </div>
            );
          })}
        </div>

        {/* FAQ note */}
        <div style={{
          marginTop: 40, textAlign: 'center', fontSize: 13, color: '#4a5f80', lineHeight: 1.8,
        }}>
          Questions? Email us at{' '}
          <a href="mailto:yahiawarsame@gmail.com" style={{ color: '#22d3a4', textDecoration: 'none' }}>
            yahiawarsame@gmail.com
          </a>
          &nbsp;— we typically respond within a few hours.
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        © 2025 FeeFlow · Built for African schools · yahiawarsame@gmail.com
      </footer>

      <style>{`
        @media (max-width: 768px) {
          #pricing > div:last-of-type {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </div>
  );
};

export default Landing;
