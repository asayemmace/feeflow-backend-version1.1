import { useNavigate } from 'react-router-dom';

/**
 * BRAND LOGO COMPONENT
 * Minimalist currency flow symbol matching your FeeFlow identity.
 */
const LogoIcon = ({ size = 32, color = "#22d3a4" }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke={color} 
    strokeWidth="1.8" 
    strokeLinecap="round" 
    strokeLinejoin="round"
  >
    <path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
  </svg>
);

const SECTIONS = [
  {
    id: 'acceptance',
    title: '1. Acceptance of Terms',
    content: `By creating a FeeFlow account, accessing our platform, or using any of our services, you ("the School", "the User", or "the Bursar") agree to be legally bound by these Terms and Conditions ("Terms"). If you do not agree with any part of these Terms, you must not use FeeFlow.

These Terms apply to all users of the platform, including administrators, bursars, and any staff members granted access to a school's FeeFlow account. FeeFlow is operated by Yahia Warsame ("we", "us", "our") and is offered as a managed software service for educational institutions.

We reserve the right to update these Terms at any time. Continued use of the platform after changes constitutes your acceptance of the updated Terms. We will notify registered users of material changes via email.`,
  },
  {
    id: 'services',
    title: '2. Description of Services',
    content: `FeeFlow provides school fee management software as a managed hosted service. Features available depend on your subscription plan:

Free Plan — Student database management for up to 300 students, manual payment recording, basic fee tracking dashboard, and term management. No M-Pesa integration or automated communications.

Pro Plan (KES 20,000/month) — All Free features plus M-Pesa Daraja C2B payment integration, automated invoice generation and delivery via WhatsApp, smart payment reminders (3-day, 1-day, and overdue alerts), and full analytics for up to 800 students.

Max Plan (Custom pricing) — All Pro features plus unlimited students, instant receipt generation, priority support, dedicated account manager, and custom onboarding assistance.

We reserve the right to modify, suspend, or discontinue any feature with reasonable notice. New features may be added at no extra cost or introduced as part of a plan upgrade.`,
  },
  {
    id: 'payments',
    title: '3. Subscription & Payment Terms',
    content: `Pro Plan subscriptions are billed monthly at KES 20,000. Payment is due at the start of each billing cycle. Max Plan pricing is agreed upon individually via a written quote before service commencement.

Accepted payment methods for FeeFlow subscriptions include M-Pesa Paybill, bank transfer, and other methods agreed upon in writing. Invoices are issued monthly and must be settled within 7 days of the billing date.

Failure to pay within 14 days of the due date will result in automatic downgrade to the Free plan. Accounts will not be deleted; all student data will be preserved. You may re-upgrade at any time by settling the outstanding balance.

No refunds are issued for partial months of service. If you cancel mid-month, you retain access to Pro/Max features until the end of the current billing period. Annual payment discounts may be available — contact us directly.

We reserve the right to revise subscription pricing with 30 days' written notice to active subscribers. Price changes will not take effect on active subscriptions until the next renewal period.`,
  },
  {
    id: 'mpesa',
    title: '4. M-Pesa Integration & API Credentials',
    content: `To enable M-Pesa payment collection, Pro and Max plan subscribers must provide their Safaricom Daraja API credentials, including a Consumer Key, Consumer Secret, and Paybill shortcode. You may alternatively use FeeFlow's shared Paybill number under a sub-account arrangement at our discretion.

ENCRYPTION AND STORAGE: All API credentials you provide are encrypted at rest using AES-256 encryption before being stored in our database. Your Consumer Key and Consumer Secret are never stored in plain text. Neither FeeFlow staff, nor any third party with access to our infrastructure, can read or retrieve your credentials in their original form. Credentials are decrypted only in memory, at the moment they are needed to make an authenticated API call to Safaricom, and are never logged, printed, or written to disk in plain text.

You remain the owner of your Daraja credentials at all times. You may revoke and replace them at any time via your account settings. FeeFlow will only use your credentials to process payment callbacks and STK Push requests on behalf of your school.

You are responsible for ensuring your Daraja credentials are valid and that your M-Pesa Paybill account remains active and in good standing with Safaricom. FeeFlow is not liable for payment failures arising from expired credentials, suspended Paybill accounts, or Safaricom service outages.

Sharing your Daraja credentials with FeeFlow does not transfer ownership or control of your Paybill account. You may withdraw consent and remove your credentials from FeeFlow at any time.`,
  },
  {
    id: 'data',
    title: '5. Data Collection & Privacy',
    content: `FeeFlow collects and processes the following categories of data to deliver our services:

School & Administrator Data: Name, email address, school name, phone number, and subscription details of the registered account holder.

Student & Parent Data: Student names, admission numbers, class information, fee amounts, payment status, and parent/guardian contact details (phone number and email) as entered by your school's staff.

Payment Data: M-Pesa transaction references, payment amounts, timestamps, and matching records. We do not store M-Pesa PINs, card numbers, or any financial credentials belonging to parents or students.

Usage Data: Login timestamps, feature usage logs, and error reports used for service improvement and security monitoring.

DATA RESIDENCY: All data is stored on secured cloud infrastructure. We take reasonable technical measures to protect data against unauthorised access, loss, or disclosure.

THIRD-PARTY SHARING: We do not sell, rent, or trade your school's data or your students' data to any third party for commercial purposes. Data may be shared with service providers (e.g., database hosting, email delivery) solely for the purpose of operating FeeFlow, under strict data processing agreements.

You may request a full export of your school's data at any time by contacting us. Upon account termination, data is retained for 90 days before permanent deletion, unless a shorter period is requested.`,
  },
  {
    id: 'whatsapp',
    title: '6. WhatsApp & SMS Communications',
    content: `FeeFlow uses WhatsApp messaging (via the Rapiwa API) to deliver invoices and payment reminders to parents and guardians on behalf of your school. By enabling this feature, you confirm that:

You have obtained the necessary consent from parents and guardians to receive automated WhatsApp messages from your school's number regarding fee matters.

You will only use this feature to send legitimate, school fee-related communications. Mass commercial messaging, spam, or messages unrelated to fee collection are strictly prohibited.

FeeFlow is not responsible for WhatsApp message delivery failures arising from recipients blocking the sending number, incorrect phone numbers in your database, or WhatsApp service restrictions.

Misuse of automated messaging may result in your account being suspended without refund. FeeFlow reserves the right to disconnect WhatsApp integration if we receive credible reports of abuse.`,
  },
  {
    id: 'liability',
    title: '7. Limitation of Liability',
    content: `FeeFlow is provided "as is" and "as available". While we strive for high uptime and data integrity, we make no guarantees that the service will be uninterrupted, error-free, or that all data will be preserved under all circumstances.

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, FEEFLOW SHALL NOT BE LIABLE FOR: loss of revenue, loss of data, business interruption, or any indirect, incidental, or consequential damages arising from your use of or inability to use the platform, even if we were advised of the possibility of such damages.

Our total aggregate liability to you for any claim arising from these Terms or your use of the platform shall not exceed the total subscription fees paid by you in the 3 months preceding the claim.

Nothing in these Terms limits liability for fraud, gross negligence, or wilful misconduct.`,
  },
  {
    id: 'termination',
    title: '8. Account Termination',
    content: `You may terminate your FeeFlow account at any time by contacting us in writing. Upon termination, your subscription will not be renewed, and your account will be downgraded to Free or closed depending on your preference.

FeeFlow reserves the right to suspend or terminate any account that: violates these Terms; engages in fraudulent or abusive activity; remains unpaid beyond 30 days; or is found to be using the platform for purposes other than legitimate school fee management.

In the event of termination by FeeFlow for cause, no refund of subscription fees will be issued. In the event of termination for reasons within our control (e.g., service discontinuation), a pro-rated refund will be offered.`,
  },
  {
    id: 'governing',
    title: '9. Governing Law & Disputes',
    content: `These Terms are governed by and construed in accordance with the laws of the Republic of Kenya. Any disputes arising from these Terms or your use of FeeFlow shall first be referred to good-faith negotiation between the parties.

If a dispute cannot be resolved through negotiation within 30 days, it shall be submitted to the jurisdiction of the courts of Nairobi, Kenya.

If any provision of these Terms is found to be unenforceable, the remaining provisions will continue in full force and effect.`,
  },
  {
    id: 'contact',
    title: '10. Contact & Support',
    content: `For questions about these Terms, data requests, billing disputes, or technical support, contact us at:

Email: yahiawarsame@gmail.com
Response time: Typically within a few business hours for urgent matters; 24–48 hours for general enquiries.

For Max plan subscribers, your dedicated account manager is your first point of contact. For Pro and Free plan users, all support is handled via email.

These Terms were last updated on 1 May 2025.`,
  },
];

export default function TermsPage() {
  const navigate = useNavigate();

  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      color: 'var(--text)',
      fontFamily: "'DM Sans', sans-serif",
    }}>
      {/* Top nav */}
      <nav style={{
        position: 'sticky', top: 0, zIndex: 100,
        borderBottom: '1px solid var(--border)',
        background: 'rgba(11,15,26,0.95)',
        backdropFilter: 'blur(12px)',
        padding: '0 32px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 64,
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 12,
          }}
        >
          <LogoIcon />
          <span style={{ 
            fontFamily: "'Nohemi', 'DM Sans', sans-serif", 
            fontSize: 20, 
            fontWeight: 700, 
            color: 'var(--text)',
            letterSpacing: '-0.02em' 
          }}>
            FeeFlow
          </span>
        </button>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'transparent', 
            border: '1px solid var(--border)',
            color: 'var(--text2)', 
            padding: '8px 16px', 
            borderRadius: 8,
            fontSize: 13, 
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Back to Home
        </button>
      </nav>

      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '64px 24px 80px' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 72 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            background: 'rgba(34,211,164,0.08)', border: '1px solid rgba(34,211,164,0.15)',
            borderRadius: 20, padding: '6px 14px', marginBottom: 28,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22d3a4' }} />
            <span style={{ 
              fontSize: 11, 
              fontWeight: 700, 
              color: '#22d3a4', 
              textTransform: 'uppercase', 
              letterSpacing: '0.1em' 
            }}>
              Compliance & Legal
            </span>
          </div>
          <h1 style={{
            fontFamily: "'Nohemi', 'DM Sans', sans-serif",
            fontSize: 'clamp(36px, 6vw, 56px)',
            fontWeight: 700, color: 'var(--text)',
            letterSpacing: '-0.035em', lineHeight: 1.05, marginBottom: 20,
          }}>Terms & Conditions</h1>
          <p style={{ color: 'var(--text2)', fontSize: 16, maxWidth: 580, margin: '0 auto', lineHeight: 1.6 }}>
            Comprehensive guidelines regarding your school's use of the FeeFlow platform and our commitment to your data security.
          </p>
          <div style={{ marginTop: 24, fontSize: 13, color: 'var(--text3)', letterSpacing: '0.01em' }}>
            Last updated: 1 May 2025 &nbsp;·&nbsp; Version 1.2
          </div>
        </div>

        {/* Layout: TOC + Content */}
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 56, alignItems: 'start' }}>

          {/* Sticky TOC */}
          <div style={{
            position: 'sticky', top: 96,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 12, padding: '24px 20px',
          }}>
            <div style={{ 
              fontSize: 10, 
              fontWeight: 800, 
              textTransform: 'uppercase', 
              letterSpacing: '0.12em', 
              color: 'var(--text3)', 
              marginBottom: 18 
            }}>
              Table of Contents
            </div>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => scrollTo(s.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '8px 12px', borderRadius: 8, marginBottom: 4,
                  fontSize: 13, color: 'var(--text2)',
                  fontWeight: 500,
                  transition: 'all .2s',
                }}
                onMouseEnter={e => { e.target.style.background = 'var(--surface2)'; e.target.style.color = 'var(--text)'; }}
                onMouseLeave={e => { e.target.style.background = 'none'; e.target.style.color = 'var(--text2)'; }}
              >
                {s.title.replace(/^\d+\.\s/, '')}
              </button>
            ))}
          </div>

          {/* Sections */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 48 }}>
            {SECTIONS.map((s) => (
              <section
                key={s.id}
                id={s.id}
                style={{
                  scrollMarginTop: 100,
                }}
              >
                <h2 style={{
                  fontFamily: "'Nohemi', 'DM Sans', sans-serif",
                  fontSize: 22, fontWeight: 700, color: 'var(--text)',
                  letterSpacing: '-0.02em', marginBottom: 20,
                  paddingBottom: 12, borderBottom: '1px solid var(--border)'
                }}>{s.title}</h2>
                
                <div style={{
                  color: 'var(--text2)', fontSize: 14.5, lineHeight: 1.8,
                  whiteSpace: 'pre-line',
                }}>
                  {s.content.split('\n\n').map((para, i) => {
                    const isBold = para === para.toUpperCase() && para.length > 10;
                    return (
                      <p key={i} style={{
                        marginBottom: 16,
                        color: isBold ? 'var(--text)' : 'var(--text2)',
                        fontWeight: isBold ? 700 : 400,
                        fontSize: isBold ? 12.5 : 14.5,
                        letterSpacing: isBold ? '0.04em' : 'normal',
                      }}>{para}</p>
                    );
                  })}
                </div>
              </section>
            ))}

            {/* Bottom acceptance reminder */}
            <div style={{
              background: 'var(--surface)',
              border: '1px solid #22d3a433',
              borderRadius: 16, padding: '32px', textAlign: 'center',
              boxShadow: '0 10px 30px -10px rgba(0,0,0,0.2)'
            }}>
              <h3 style={{ 
                fontFamily: "'Nohemi', 'DM Sans', sans-serif", 
                fontSize: 20, color: 'var(--text)', 
                marginBottom: 12, letterSpacing: '-0.01em' 
              }}>
                Ready to automate your school?
              </h3>
              <p style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.6, maxWidth: 480, margin: '0 auto 24px' }}>
                By proceeding to create your account, you confirm that you have reviewed and agree to these Terms and Conditions.
              </p>
              <button
                onClick={() => navigate('/register')}
                style={{
                  background: '#22d3a4', color: '#0b1a14',
                  border: 'none', borderRadius: 10, padding: '12px 32px',
                  fontSize: 14, fontWeight: 700, cursor: 'pointer',
                  letterSpacing: '0.01em',
                }}
              >
                Accept and Register
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer style={{
        borderTop: '1px solid var(--border)',
        padding: '40px 32px',
        textAlign: 'center',
        background: 'var(--surface)',
        fontSize: 13, color: 'var(--text3)',
      }}>
        © 2025 FeeFlow · Built for African schools ·{' '}
        <a href="mailto:yahiawarsame@gmail.com" style={{ color: 'var(--text2)', textDecoration: 'none', fontWeight: 500 }}>
          yahiawarsame@gmail.com
        </a>
      </footer>

      <style>{`
        @media (max-width: 900px) {
          nav { padding: 0 16px !important; }
          .terms-layout { grid-template-columns: 1fr !important; }
          button[style*="display: block"] { display: none !important; }
        }
      `}</style>
    </div>
  );
}