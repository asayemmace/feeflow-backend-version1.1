import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

const LogoIcon = () => (
  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
  </svg>
);

const FEATURES = [
  {
    color: '#22d3a4', bg: 'rgba(34,211,164,0.05)', border: 'rgba(34,211,164,0.1)',
    title: 'M-Pesa Integration',
    desc: 'Native Daraja API matching. Every transaction is automatically synced to the student ledger in real-time.',
    icon: <path d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"/>,
  },
  {
    color: '#3b82f6', bg: 'rgba(59,130,246,0.05)', border: 'rgba(59,130,246,0.1)',
    title: 'Instant Receipts',
    desc: 'Generate and deliver professional digital receipts to parents the moment a payment is confirmed.',
    icon: <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>,
  },
  {
    color: '#f59e0b', bg: 'rgba(245,158,11,0.05)', border: 'rgba(245,158,11,0.1)',
    title: 'Smart Reminders',
    desc: 'Intelligent multi-stage payment alerts that reduce manual follow-ups and improve collection rates.',
    icon: <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>,
  },
];

const PLANS = [
  {
    name: "Standard",
    priceLabel: "KES 0",
    sub: "Up to 300 students",
    accent: "var(--text3)",
    cta: "Start Free",
    features: [
      { text: "Fee balance tracking", included: true },
      { text: "Basic finance dashboard", included: true },
      { text: "Term & Class management", included: true },
      { text: "Manual record entry", included: true },
      { text: "Instant Digital Receipts", included: false },
      { text: "M-Pesa STK Push", included: false },
      { text: "Automated Invoicing", included: false },
    ],
  },
  {
    name: "Professional",
    priceLabel: "KES 20,000",
    sub: "Billed monthly",
    badge: "Recommended",
    accent: "#22d3a4",
    cta: "Start Free Trial",
    features: [
      { text: "Up to 800 students", included: true },
      { text: "Full M-Pesa STK Integration", included: true },
      { text: "Instant Digital Receipts", included: true },
      { text: "Real-time Collection Analytics", included: true },
      { text: "Parent SMS Alerts", included: true },
      { text: "Multi-user staff access", included: true },
      { text: "Automated Invoicing", included: false },
    ],
  },
  {
    name: "Enterprise",
    priceLabel: "Custom",
    sub: "Unlimited students",
    accent: "#f59e0b",
    cta: "Contact Sales",
    features: [
      { text: "Everything in Professional", included: true },
      { text: "Automated Bulk Invoicing", included: true },
      { text: "Priority 24/7 Support", included: true },
      { text: "Custom Data Migration", included: true },
      { text: "Dedicated Account Manager", included: true },
      { text: "Custom API Integration", included: true },
      { text: "White-label branding", included: true },
    ],
  },
];

const Landing = () => {
  const navigate = useNavigate();
  const { token } = useAuth();

  useEffect(() => {
    if (token) navigate('/dashboard');
  }, [token, navigate]);

  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

  return (
    <div style={{ background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh', letterSpacing: '0.01em' }}>
      {/* Navigation */}
      <nav className="landing-nav">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700, fontSize: 18 }}>
          <div style={{ width: 28, color: '#22d3a4' }}><LogoIcon /></div>
          <span style={{ letterSpacing: '-0.3px' }}>FeeFlow</span>
        </div>
        <div className="landing-nav-links" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <a href="#features" onClick={(e) => { e.preventDefault(); scrollTo('features'); }} 
             style={{ fontSize: 13, color: 'var(--text2)', textDecoration: 'none', fontWeight: 500 }}>Features</a>
          <a href="#pricing" onClick={(e) => { e.preventDefault(); scrollTo('pricing'); }} 
             style={{ fontSize: 13, color: 'var(--text2)', textDecoration: 'none', fontWeight: 500 }}>Pricing</a>
          <button className="btn btn-outline" style={{ borderRadius: 8, padding: '6px 14px', fontSize: 13 }} onClick={() => navigate('/login')}>Sign In</button>
          <button className="btn btn-primary" style={{ borderRadius: 8, padding: '6px 16px', fontSize: 13 }} onClick={() => navigate('/register')}>Get Started</button>
        </div>
      </nav>

      {/* Hero Section */}
      <section style={{ textAlign: 'center', padding: '60px 24px 40px', maxWidth: 800, margin: '0 auto' }}>
        <div style={{ 
          display: 'inline-block', padding: '4px 12px', background: 'var(--surface2)', 
          borderRadius: 100, fontSize: 11, fontWeight: 600, color: '#22d3a4', marginBottom: 20,
          letterSpacing: '0.03em', border: '1px solid var(--border)'
        }}>
          TRUSTED BY KENYAN SCHOOLS
        </div>
        <h1 style={{ fontSize: 'clamp(32px, 4vw, 52px)', fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.02em', marginBottom: 20 }}>
          School fee management, <br/><span style={{ color: '#22d3a4' }}>automated for excellence.</span>
        </h1>
        <p style={{ fontSize: 15, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 32, maxWidth: 540, margin: '0 auto 32px' }}>
          Stop chasing payments. Automate your bursar office with native M-Pesa integration, instant digital receipts, and real-time tracking.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
          <button className="btn btn-primary" style={{ padding: '12px 28px', borderRadius: 10, fontSize: 14 }} onClick={() => navigate('/register')}>Start free trial</button>
          <button className="btn btn-outline" style={{ padding: '12px 28px', borderRadius: 10, fontSize: 14 }} onClick={() => scrollTo('pricing')}>View pricing</button>
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" style={{ padding: '40px 5%', maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
          {FEATURES.map(f => (
            <div key={f.title} style={{ 
              padding: 32, borderRadius: 20, background: 'var(--surface)', border: '1px solid var(--border)',
              transition: 'all 0.2s ease'
            }}>
              <div style={{ 
                width: 40, height: 40, borderRadius: 10, background: f.bg, border: `1px solid ${f.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: f.color, marginBottom: 20
              }}>
                <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>{f.icon}</svg>
              </div>
              <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>{f.title}</h3>
              <p style={{ color: 'var(--text2)', lineHeight: 1.6, fontSize: 14 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing Section - Comparative List Style */}
      <section id="pricing" style={{ padding: '60px 5%', background: 'var(--surface2)', borderTop: '1px solid var(--border)' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <h2 style={{ fontSize: 32, fontWeight: 800, marginBottom: 12 }}>Predictable pricing</h2>
            <p style={{ color: 'var(--text2)', fontSize: 15 }}>The right tools for every stage of your school's growth.</p>
          </div>
          
          <div className='pricing-grid'>
            {PLANS.map(plan => (
              <div key={plan.name} style={{ 
                background: 'var(--surface)', padding: 32, borderRadius: 20, border: '1px solid var(--border)',
                display: 'flex', flexDirection: 'column', position: 'relative'
              }}>
                {plan.badge && (
                  <span style={{ 
                    position: 'absolute', top: -10, right: 20, background: '#22d3a4', color: '#0b1a14',
                    fontSize: 10, fontWeight: 800, padding: '3px 10px', borderRadius: 100, textTransform: 'uppercase'
                  }}>{plan.badge}</span>
                )}
                <div style={{ fontWeight: 700, color: plan.accent, marginBottom: 6, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{plan.name}</div>
                <div style={{ fontSize: 28, fontWeight: 800, marginBottom: 2 }}>{plan.priceLabel}</div>
                <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 24 }}>{plan.sub}</div>
                
                <div style={{ flex: 1, marginBottom: 28 }}>
                  {plan.features.map((feat, i) => (
                    <div key={i} style={{ 
                        display: 'flex', gap: 10, marginBottom: 10, fontSize: 13, 
                        color: feat.included ? 'var(--text2)' : 'var(--text3)',
                        opacity: feat.included ? 1 : 0.6
                    }}>
                      <span style={{ color: feat.included ? '#22d3a4' : 'var(--text3)', fontWeight: 700 }}>
                        {feat.included ? '✓' : '○'}
                      </span> 
                      <span style={{ textDecoration: feat.included ? 'none' : 'line-through' }}>{feat.text}</span>
                    </div>
                  ))}
                </div>
                
                <button className={`btn ${plan.accent === '#22d3a4' ? 'btn-primary' : 'btn-outline'}`} 
                        style={{ width: '100%', padding: '12px', borderRadius: 10, fontSize: 14 }}
                        onClick={() => navigate('/register')}>
                  {plan.cta}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Simplified Footer */}
      <footer style={{ padding: '60px 5% 40px', maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 40 }}>
          <div style={{ maxWidth: 280 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 16, marginBottom: 12 }}>
              <div style={{ width: 22, color: '#22d3a4' }}><LogoIcon /></div>
              <span>FeeFlow</span>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text3)', lineHeight: 1.6 }}>
              Built for African schools to automate collections and ensure transparency.
            </p>
          </div>
          
          <div style={{ display: 'flex', gap: 60 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 16, textTransform: 'uppercase', color: 'var(--text2)' }}>Product</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
                <a href="#features" style={{ color: 'var(--text3)', textDecoration: 'none' }}>Features</a>
                <a href="#pricing" style={{ color: 'var(--text3)', textDecoration: 'none' }}>Pricing</a>
                <a href="mailto:yahiawarsame@gmail.com" style={{ color: 'var(--text3)', textDecoration: 'none' }}>Support</a>
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 16, textTransform: 'uppercase', color: 'var(--text2)' }}>Company</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
                <a href="/terms" style={{ color: 'var(--text3)', textDecoration: 'none' }}>Privacy</a>
                <a href="/terms" style={{ color: 'var(--text3)', textDecoration: 'none' }}>Terms</a>
              </div>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 60, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
          © {new Date().getFullYear()} FeeFlow. Based in Nairobi.
        </div>
      </footer>

      <style>{`
        .btn { transition: all 0.15s ease; cursor: pointer; font-family: inherit; font-weight: 600; border: 1px solid transparent; display: inline-flex; align-items: center; justify-content: center; }
        .btn-primary { background: #22d3a4; color: #0b1a14; }
        .btn-primary:hover { opacity: 0.9; }
        .btn-outline { background: transparent; border-color: var(--border); color: var(--text2); }
        .btn-outline:hover { background: var(--surface2); color: var(--text); border-color: var(--text3); }

      `}</style>
    </div>
  );
};

export default Landing;