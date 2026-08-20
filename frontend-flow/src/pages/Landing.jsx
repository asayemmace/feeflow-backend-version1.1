import { useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import SupportModal from '../components/SupportModal';
import feeflowLogo from '../assets/feeflow-logo.png';

const LogoIcon = () => (
  <img src={feeflowLogo} alt="FeeFlow" style={{ width: '100%', height: 'auto', objectFit: 'contain', display: 'block' }} />
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

// Plan features are derived directly from server.js PLAN_LIMITS and planFeatures():
//   free:  { students: 300,      mpesa: false, invoices: false, receipts: false, staff: false }
//   pro:   { students: 800,      mpesa: true,  invoices: true,  receipts: false, staff: false }
//   max:   { students: Infinity, mpesa: true,  invoices: true,  receipts: true,  staff: true  }
//
// Pricing source: SUBSCRIPTION_PLANS = { pro: { amount: 20000 } }
// Max plan is contact-sales (no self-serve billing route exists for it yet).
//
// WOW feature strategy: each plan shows its own headline wins first,
// then crossed-out lines for the next tier's headline unlocks — so the
// upgrade value is immediately visible.
const PLANS = [
  {
    name: "Free",
    priceLabel: "KES 0",
    sub: "Up to 300 students · Forever free",
    accent: "var(--text3)",
    cta: "Get Started",
    features: [
      // ✅ What Free actually gives you
      { text: "Up to 300 students", included: true },
      { text: "Fee balance & ledger tracking", included: true },
      { text: "Term & class management", included: true },
      { text: "Manual payment recording", included: true },
      { text: "Basic finance dashboard", included: true },
      // ❌ Crossed — available in Pro (upgrade hooks)
      { text: "M-Pesa STK Push payments", included: false },
      { text: "Automated invoicing & reminders", included: false },
    ],
  },
  {
    name: "Pro",
    priceLabel: "KES 5,000",
    sub: "Per month · Up to 600 students",
    badge: "Most Popular",
    accent: "#22d3a4",
    cta: "Start Free Trial",
    features: [
      // ✅ Pro's WOW unlocks
      { text: "Up to 600 students", included: true },
      { text: "M-Pesa STK Push — pay from dashboard", included: true },
      { text: "Automated invoicing & SMS reminders", included: true },
      { text: "Bank statement upload & auto-matching", included: true },
      { text: "Real-time collection analytics", included: true },
      // ✅ Carries everything Free has
      { text: "All Free plan features", included: true },
      // ❌ Crossed — available in Max (upgrade hook)
      { text: "Instant digital receipts (PDF)", included: false },
    ],
  },
  {
    name: "Max",
    priceLabel: "7,500+",
    sub: "1,000+ students · Full platform",
    accent: "#f59e0b",
    cta: "Talk to Sales",
    features: [
      // ✅ Max's WOW unlocks
      { text: "1,000+ students", included: true },
      { text: "Instant PDF receipts auto-sent to parents", included: true },
      { text: "Multi-staff access with role permissions", included: true },
      { text: "Bulk invoice sending to entire classes", included: true },
      { text: "Full audit log — every action tracked", included: true },
      { text: "Overpayment credit memos", included: true },
      // ✅ Carries everything Pro has
      { text: "All Pro plan features", included: true },
    ],
  },
];

function useInView() {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); obs.disconnect(); } },
      { threshold: 0.15 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return [ref, inView];
}

const FeatureCard = ({ f, index }) => {
  const [ref, inView] = useInView();
  const existingCardStyles = {
    padding: 32, borderRadius: 20, background: 'var(--surface)', border: '1px solid var(--border)',
    transition: 'all 0.2s ease'
  };

  return (
    <div
      ref={ref}
      className="feature-card"
      style={{
        ...existingCardStyles,
        opacity: inView ? 1 : 0,
        transform: inView ? 'translateY(0)' : 'translateY(32px)',
        transition: `opacity 0.55s ease ${index * 0.12}s, transform 0.55s ease ${index * 0.12}s`,
      }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width - 0.5) * 12;
        const y = ((e.clientY - rect.top) / rect.height - 0.5) * -12;
        e.currentTarget.style.transform = `perspective(600px) rotateX(${y}deg) rotateY(${x}deg) translateY(-4px)`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'perspective(600px) rotateX(0deg) rotateY(0deg)';
      }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 10, background: f.bg, border: `1px solid ${f.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: f.color, marginBottom: 20
      }}>
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>{f.icon}</svg>
      </div>
      <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 10 }}>{f.title}</h3>
      <p style={{ color: 'var(--text2)', lineHeight: 1.6, fontSize: 14 }}>{f.desc}</p>
    </div>
  );
};

const PricingCard = ({ plan, index, navigate, onContact }) => {
  const [ref, inView] = useInView();
  const existingCardStyles = {
    background: 'var(--surface)', padding: 32, borderRadius: 20, border: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', position: 'relative'
  };

  return (
    <div
      ref={ref}
      style={{
        ...existingCardStyles,
        opacity: inView ? 1 : 0,
        transform: inView ? 'translateY(0)' : 'translateY(32px)',
        transition: `opacity 0.55s ease ${index * 0.12}s, transform 0.55s ease ${index * 0.12}s`,
      }}
    >
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
              onClick={() => plan.cta === 'Talk to Sales' ? onContact?.() : navigate('/register')}>
        {plan.cta}
      </button>
    </div>
  );
};

const Landing = () => {
  const navigate = useNavigate();
  const { token } = useAuth();
  const [showSupport, setShowSupport] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (token) navigate('/dashboard');
  }, [token, navigate]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

  return (
    <div style={{ background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh', letterSpacing: '0.01em' }}>
      {/* Navigation */}
      <nav
        className="landing-nav"
        style={{
          backdropFilter: scrolled ? 'blur(16px)' : 'none',
          background: scrolled ? 'rgba(11,26,20,0.85)' : 'transparent',
          borderBottom: scrolled ? '1px solid var(--border)' : '1px solid transparent',
          transition: 'all 0.3s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700, fontSize: 18 }}>
          <div style={{ width: 28, color: '#22d3a4' }}><LogoIcon /></div>
          <span style={{ letterSpacing: '-0.3px' }}>FeeFlow</span>
        </div>
        <div className="landing-nav-links" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <a href="#features" onClick={(e) => { e.preventDefault(); scrollTo('features'); }} 
             style={{ fontSize: 13, color: 'var(--text2)', textDecoration: 'none', fontWeight: 500 }}>Features</a>
          <a href="#pricing" onClick={(e) => { e.preventDefault(); scrollTo('pricing'); }} 
             style={{ fontSize: 13, color: 'var(--text2)', textDecoration: 'none', fontWeight: 500 }}>Pricing</a>
          <button className="btn btn-outline" style={{ borderRadius: 8, padding: '6px 14px', fontSize: 13 }} onClick={() => setShowSupport(true)}>Support</button>
          <button className="btn btn-outline" style={{ borderRadius: 8, padding: '6px 14px', fontSize: 13 }} onClick={() => navigate('/login')}>Sign In</button>
          <button className="btn btn-primary" style={{ borderRadius: 8, padding: '6px 16px', fontSize: 13 }} onClick={() => navigate('/register')}>Get Started</button>
        </div>
      </nav>

      {/* Hero Section */}
      <div className="hero-bg">
        <section style={{ textAlign: 'center', padding: '60px 24px 40px', maxWidth: 800, margin: '0 auto' }}>
          <div className="hero-badge" style={{
            display: 'inline-block', padding: '4px 12px', background: 'var(--surface2)',
            borderRadius: 100, fontSize: 11, fontWeight: 600, color: '#22d3a4', marginBottom: 20,
            letterSpacing: '0.03em', border: '1px solid var(--border)'
          }}>
            TRUSTED BY KENYAN SCHOOLS
          </div>
          <h1 className="hero-h1" style={{ fontSize: 'clamp(32px, 4vw, 52px)', fontWeight: 800, lineHeight: 1.15, letterSpacing: '-0.02em', marginBottom: 20 }}>
            School fee management, <br/><span className="hero-accent">automated for excellence.</span>
          </h1>
          <p className="hero-sub" style={{ fontSize: 15, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 32, maxWidth: 540, margin: '0 auto 32px' }}>
            Stop chasing payments. Automate your bursar office with native M-Pesa integration, instant digital receipts, and real-time tracking.
          </p>
          <div className="hero-ctas" style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
            <button className="btn btn-primary" style={{ padding: '12px 28px', borderRadius: 10, fontSize: 14 }} onClick={() => navigate('/register')}>Start free trial</button>
            <button className="btn btn-outline" style={{ padding: '12px 28px', borderRadius: 10, fontSize: 14 }} onClick={() => scrollTo('pricing')}>View pricing</button>
          </div>
        </section>
      </div>

      {/* Features Grid */}
      <section id="features" style={{ padding: '40px 5%', maxWidth: 1100, margin: '0 auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
          {FEATURES.map((f, index) => (
            <FeatureCard key={f.title} f={f} index={index} />
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
            {PLANS.map((plan, index) => (
              <PricingCard key={plan.name} plan={plan} index={index} navigate={navigate} onContact={() => setShowSupport(true)} />
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
                <a href="#support" onClick={(e) => { e.preventDefault(); setShowSupport(true); }}
                  style={{ color: 'var(--text3)', textDecoration: 'none' }}>
                  Support
                </a>
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 16, textTransform: 'uppercase', color: 'var(--text2)' }}>Company</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
                <a href="/privacy" style={{ color: 'var(--text3)', textDecoration: 'none' }}>Privacy</a>
                <a href="/terms" style={{ color: 'var(--text3)', textDecoration: 'none' }}>Terms</a>
              </div>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 60, textAlign: 'center', color: 'var(--text3)', fontSize: 12 }}>
         © 2026 Fee Flow Solutions
        </div>
      </footer>

      <style>{`
        .btn { transition: all 0.15s ease; cursor: pointer; font-family: inherit; font-weight: 600; border: 1px solid transparent; display: inline-flex; align-items: center; justify-content: center; }
        .btn-primary { background: #22d3a4; color: #0b1a14; }
        .btn-primary:hover { opacity: 0.9; }
        .btn-outline { background: transparent; border-color: var(--border); color: var(--text2); }
        .btn-outline:hover { background: var(--surface2); color: var(--text); border-color: var(--text3); }
        .landing-nav button { font: inherit; }

        /* Hero entrance */
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(24px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes shimmer {
          0%   { background-position: -200% center; }
          100% { background-position:  200% center; }
        }
        @keyframes meshDrift {
          0%, 100% { background-position: 0% 50%; }
          50%       { background-position: 100% 50%; }
        }

        .hero-badge { animation: fadeUp 0.5s ease both; animation-delay: 0.1s; }
        .hero-h1    { animation: fadeUp 0.6s ease both; animation-delay: 0.25s; }
        .hero-sub   { animation: fadeUp 0.6s ease both; animation-delay: 0.4s; }
        .hero-ctas  { animation: fadeUp 0.6s ease both; animation-delay: 0.55s; }

        .hero-accent {
          background: linear-gradient(90deg, #22d3a4 30%, #80ffe8 50%, #22d3a4 70%);
          background-size: 200% auto;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          animation: shimmer 3s linear infinite;
        }

        .hero-bg {
          background:
            radial-gradient(ellipse 60% 40% at 20% 50%, rgba(34,211,164,0.07) 0%, transparent 70%),
            radial-gradient(ellipse 50% 40% at 80% 30%, rgba(59,130,246,0.06) 0%, transparent 70%),
            var(--bg);
          background-size: 300% 300%;
          animation: meshDrift 12s ease infinite;
        }

        /* Button shimmer sweep */
        .btn-primary { position: relative; overflow: hidden; }
        .btn-primary::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
          transform: translateX(-100%);
          transition: transform 0.4s ease;
        }
        .btn-primary:hover::after { transform: translateX(100%); }
        .btn-primary:active { transform: scale(0.97); transition: transform 0.1s ease; }

        /* Feature card tilt transition */
        .feature-card { transition: transform 0.3s ease, box-shadow 0.3s ease; }
        .feature-card:hover { box-shadow: 0 20px 60px rgba(34,211,164,0.08); }
      `}</style>
      {showSupport && <SupportModal onClose={() => setShowSupport(false)} />}
    </div>
  );
};

export default Landing;
