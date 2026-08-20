import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

const CONTACT_EMAIL = 'feeflow254@gmail.com';

const LogoIcon = ({ size = 32, color = '#22d3a4' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const TERMS_SECTIONS = [
  {
    id: 'acceptance',
    title: '1. Acceptance of Terms',
    content: `By creating an account, accessing FeeFlow, or using any FeeFlow service, you agree to these Terms and Conditions on behalf of the school, institution, or organization you represent.

FeeFlow is the product and trade name of Fee Flow Solutions. These Terms govern your use of the hosted school fee management platform, related dashboards, notifications, payment tools, reports, and support services.

If you do not agree to these Terms, you should not create an account or continue using FeeFlow. Fee Flow Solutions may update these Terms from time to time, and continued use after notice of material changes means you accept the updated Terms.`,
  },
  {
    id: 'services',
    title: '2. Description of Services',
    content: `FeeFlow helps schools manage student fee records, generate invoices and receipts, track payments, view reports, manage terms, and communicate fee-related information to parents or guardians.

Available features depend on the school's subscription plan. Fee Flow Solutions may improve, modify, suspend, or discontinue features where necessary for security, reliability, compliance, or product development.

FeeFlow is a management and record-keeping platform. Schools remain responsible for reviewing, approving, and verifying their financial records, student data, parent contact information, and accounting decisions.`,
  },
  {
    id: 'billing',
    title: '3. Subscription & Billing',
    content: `Paid plans are billed according to the subscription terms agreed with the school. Fees, billing cycles, limits, and included features may vary by plan or written agreement.

Schools are responsible for paying subscription fees when due. Failure to pay may result in downgrade, feature restriction, suspension, or termination after reasonable notice.

Unless otherwise agreed in writing, subscription payments are non-refundable for partial billing periods. Fee Flow Solutions may revise pricing with reasonable notice to affected customers.`,
  },
  {
    id: 'mpesa',
    title: '4. Payment Processing & M-Pesa Integration',
    content: `FeeFlow may support M-Pesa payment collection and reconciliation for eligible schools. Schools retain ownership and control of their M-Pesa accounts and credentials at all times.

M-Pesa credentials provided by schools are encrypted at rest and are never stored in plain text. FeeFlow uses secure, industry-standard encryption practices to protect sensitive credential data.

Credentials are only decrypted temporarily during authenticated API requests required to process school-authorized payment activity. Plain-text credentials are not logged or displayed to FeeFlow staff.

Fee Flow Solutions cannot access customer M-Pesa PINs and does not request, process, or store parent M-Pesa PINs.

Schools are responsible for ensuring their payment credentials, paybill details, account permissions, and contact information are accurate and active. Fee Flow Solutions is not liable for payment failures caused by telecom outages, Safaricom outages, internet failures, invalid credentials, suspended accounts, incorrect parent data, or other issues outside FeeFlow's reasonable control.`,
  },
  {
    id: 'responsibilities',
    title: '5. User Responsibilities',
    content: `Schools must use FeeFlow only for lawful school fee management and related administrative purposes.

Schools are responsible for the accuracy of student records, parent contact details, fee structures, payment entries, invoice details, receipt details, staff access permissions, and uploaded data.

Account administrators must keep login credentials confidential, assign access only to authorized staff, and promptly remove access for staff who no longer require it.

Schools must not misuse FeeFlow to send spam, misleading communications, unlawful notices, or messages unrelated to school fee administration.`,
  },
  {
    id: 'communications',
    title: '6. Communications & Notifications',
    content: `FeeFlow may help schools send fee-related SMS and email notifications, including invoices, receipts, reminders, and payment confirmations.

Schools are responsible for obtaining appropriate consent from parents or guardians before sending automated SMS or email communications through FeeFlow.

Schools are also responsible for ensuring contact details are correct and for responding to parent questions about balances, invoices, receipts, payment allocation, and school policies.

Fee Flow Solutions does not guarantee delivery of every SMS or email because delivery may depend on network conditions, recipient settings, incorrect contact details, and infrastructure outside FeeFlow's control.`,
  },
  {
    id: 'security',
    title: '7. Data Security & Encryption',
    content: `Fee Flow Solutions applies commercially reasonable security measures to protect FeeFlow accounts and data.

Security measures may include role-based access controls, encrypted credentials, secure cloud infrastructure, audit logging, session and token protection, regular monitoring, backup and recovery measures, HTTPS/TLS encrypted communication, and administrative controls for authorized access.

No internet-based service can be guaranteed to be completely secure. Schools must also protect their own devices, passwords, staff accounts, and internal procedures.`,
  },
  {
    id: 'availability',
    title: '8. Service Availability',
    content: `FeeFlow is provided as a hosted service and may occasionally be unavailable due to maintenance, updates, security work, internet disruption, cloud infrastructure issues, telecom outages, or events outside our reasonable control.

Fee Flow Solutions aims to maintain reliable access and may perform maintenance to improve performance, security, and stability. Where practical, we will provide notice of material planned downtime.`,
  },
  {
    id: 'liability',
    title: '9. Limitation of Liability',
    content: `FeeFlow assists schools with fee management, but schools remain responsible for verifying financial records, reconciling payments, confirming balances, and making final accounting decisions.

To the maximum extent permitted by law, Fee Flow Solutions is not liable for indirect, incidental, special, consequential, or punitive damages, loss of revenue, loss of data, business interruption, incorrect data entered by schools, telecom outages, Safaricom outages, internet failures, or failed message delivery.

Where liability cannot be excluded, the total liability of Fee Flow Solutions for claims relating to FeeFlow will be limited to the subscription fees paid by the school during the three months before the event giving rise to the claim.`,
  },
  {
    id: 'termination',
    title: '10. Suspension & Termination',
    content: `Schools may stop using FeeFlow by contacting Fee Flow Solutions or by allowing their subscription to expire.

Fee Flow Solutions may suspend or terminate access if a school fails to pay, violates these Terms, misuses communications, creates security risk, provides false information, or uses FeeFlow for unlawful purposes.

Following cancellation or termination, data may be retained temporarily for recovery, support, legal compliance, dispute resolution, backup management, and fraud prevention before permanent deletion under applicable retention practices.`,
  },
  {
    id: 'ip',
    title: '11. Intellectual Property',
    content: `FeeFlow, including its software, design, workflows, branding, documentation, and product experience, is owned by Fee Flow Solutions or its licensors.

Schools retain ownership of their uploaded school, student, parent, fee, and payment data. Using FeeFlow does not transfer ownership of school data to Fee Flow Solutions.

Schools may not copy, reverse engineer, resell, sublicense, or commercially exploit FeeFlow except as allowed under an active subscription or written agreement.`,
  },
  {
    id: 'law',
    title: '12. Governing Law',
    content: `These Terms are governed by the laws of the Republic of Kenya.

The parties will first attempt to resolve disputes through good-faith discussion. If a dispute cannot be resolved informally, it may be submitted to the competent courts in Kenya, unless another dispute process is agreed in writing.`,
  },
  {
    id: 'contact',
    title: '13. Contact Information',
    content: `For questions about these Terms, billing, support, or legal notices, contact:

Fee Flow Solutions
Email: ${CONTACT_EMAIL}

Last updated: 13 May 2026`,
  },
];

const PRIVACY_SECTIONS = [
  {
    id: 'intro',
    title: '1. Introduction',
    content: `This Privacy Policy explains how Fee Flow Solutions collects, uses, stores, protects, and shares information when schools use FeeFlow.

FeeFlow is a school fee management product operated under the FeeFlow trade name by Fee Flow Solutions. This Policy is written for schools, administrators, parents, guardians, and other users whose information may be processed through FeeFlow.`,
  },
  {
    id: 'collect',
    title: '2. Information We Collect',
    content: `We may collect account information such as administrator names, email addresses, phone numbers, school names, login details, subscription status, support messages, and usage activity.

We may also collect operational data created in FeeFlow, including classes, terms, invoices, receipts, payment records, fee structures, reports, audit logs, and notification history.

Technical information such as device, browser, session, IP, error, and security log data may be processed to protect accounts, monitor performance, and troubleshoot issues.`,
  },
  {
    id: 'student-parent',
    title: '3. Student & Parent Data',
    content: `Schools may upload or enter student names, admission numbers, class information, fee balances, payment status, and parent or guardian contact details.

Schools own their uploaded student and parent data. Fee Flow Solutions processes that data to provide FeeFlow services on behalf of the school.

Fee Flow Solutions does not sell student or parent data.`,
  },
  {
    id: 'payment',
    title: '4. Payment Information',
    content: `FeeFlow may store payment amounts, dates, methods, allocation records, receipt numbers, invoice references, reconciliation status, and transaction references for school accounting, reconciliation, receipt generation, and reporting.

Payment references may be stored for reconciliation and receipt generation.

M-Pesa credentials are encrypted and never stored in plain text. FeeFlow does not collect or store parent M-Pesa PINs.`,
  },
  {
    id: 'use',
    title: '5. How We Use Data',
    content: `We use data to operate FeeFlow, authenticate users, manage subscriptions, generate invoices and receipts, reconcile payments, produce reports, send school-authorized SMS and email notifications, provide support, improve reliability, prevent misuse, and comply with legal obligations.

We may use aggregated or de-identified information to understand product performance and improve FeeFlow, but we do not use that information to identify individual students or parents.`,
  },
  {
    id: 'retention',
    title: '6. Data Retention',
    content: `Data is retained while a school account remains active and as needed to provide FeeFlow services.

After cancellation, data may be retained temporarily for account recovery, backup restoration, dispute handling, fraud prevention, legal compliance, and operational continuity before permanent deletion.

Schools may request export or deletion of eligible data by contacting Fee Flow Solutions.`,
  },
  {
    id: 'security',
    title: '7. Security Measures',
    content: `Fee Flow Solutions applies commercially reasonable security measures to protect data processed through FeeFlow.

Security measures may include secure HTTPS/TLS encrypted communication, encrypted credentials, role-based access controls, session and token protection, audit logging, secure cloud infrastructure, restricted administrative access, backup and recovery measures, monitoring, and access by authorized personnel only.

No system can be guaranteed to be completely secure, and schools should protect their own devices, staff accounts, passwords, and internal data practices.`,
  },
  {
    id: 'sharing',
    title: '8. Sharing of Information',
    content: `Fee Flow Solutions does not sell student or parent data.

Information may be shared only where necessary to operate FeeFlow, comply with law, protect rights and security, support school-authorized communication, process school-authorized payment workflows, or respond to lawful requests.

Where vendors or infrastructure services are used, access is limited to what is necessary to operate the service and protect FeeFlow.`,
  },
  {
    id: 'cookies',
    title: '9. Cookies & Sessions',
    content: `FeeFlow may use cookies, local storage, session tokens, or similar technologies to keep users signed in, protect accounts, remember preferences, and improve application performance.

Users can manage browser settings, but disabling required session storage may prevent FeeFlow from working correctly.`,
  },
  {
    id: 'rights',
    title: '10. User Rights',
    content: `Depending on applicable law and the school's role as data controller, users may request access, correction, export, restriction, or deletion of personal information.

Parents and guardians should usually direct student record requests to the school first, because schools own and control the student data they upload to FeeFlow.`,
  },
  {
    id: 'deletion',
    title: '11. Data Deletion Requests',
    content: `Schools may request deletion of eligible account data by contacting Fee Flow Solutions.

Some information may be retained temporarily or as required for legal compliance, financial records, dispute resolution, backups, fraud prevention, audit logs, and service security. Once retention obligations expire, eligible data will be permanently deleted or anonymized.`,
  },
  {
    id: 'contact',
    title: '12. Contact Information',
    content: `For privacy questions, data export requests, deletion requests, or security concerns, contact:

Fee Flow Solutions
Email: ${CONTACT_EMAIL}

Last updated: 13 May 2026`,
  },
];

function LegalPage({ type = 'terms' }) {
  const navigate = useNavigate();
  const [tocOpen, setTocOpen] = useState(false);
  const isPrivacy = type === 'privacy';
  const sections = isPrivacy ? PRIVACY_SECTIONS : TERMS_SECTIONS;
  const title = isPrivacy ? 'Privacy Policy' : 'Terms & Conditions';
  const subtitle = isPrivacy
    ? 'How Fee Flow Solutions protects school, student, parent, and payment information in FeeFlow.'
    : "Professional terms governing your school's use of the FeeFlow platform.";

  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTocOpen(false);
  };

  return (
    <div className="legal-page">
      <nav className="legal-nav">
        <button className="legal-brand" onClick={() => navigate('/')}>
          <LogoIcon />
          <span>FeeFlow</span>
        </button>
        <div className="legal-nav-actions">
          <Link to="/terms" className={isPrivacy ? 'legal-nav-link' : 'legal-nav-link active'}>Terms</Link>
          <Link to="/privacy" className={isPrivacy ? 'legal-nav-link active' : 'legal-nav-link'}>Privacy</Link>
          <button className="legal-back" onClick={() => navigate('/')}>Back to Home</button>
        </div>
      </nav>

      <main className="legal-wrap">
        <header className="legal-hero">
          <div className="legal-pill"><span /> Compliance & Legal</div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
          <div className="legal-meta">Fee Flow Solutions · Last updated 13 May 2026</div>
        </header>

        <button className="legal-toc-toggle" onClick={() => setTocOpen(v => !v)}>
          {tocOpen ? 'Hide contents' : 'Show contents'}
        </button>

        <div className="legal-layout">
          <aside className={tocOpen ? 'legal-toc open' : 'legal-toc'}>
            <div className="legal-toc-title">Table of Contents</div>
            {sections.map(section => (
              <button key={section.id} onClick={() => scrollTo(section.id)}>
                {section.title.replace(/^\d+\.\s/, '')}
              </button>
            ))}
          </aside>

          <div className="legal-content">
            {sections.map(section => (
              <section key={section.id} id={section.id}>
                <h2>{section.title}</h2>
                <div>
                  {section.content.split('\n\n').map((paragraph, index) => (
                    <p key={index}>{paragraph}</p>
                  ))}
                </div>
              </section>
            ))}

            <div className="legal-card">
              <h3>{isPrivacy ? 'Need a data request?' : 'Ready to continue?'}</h3>
              <p>
                {isPrivacy
                  ? `Contact ${CONTACT_EMAIL} for privacy, export, or deletion requests.`
                  : 'By creating an account, you confirm that you have reviewed and accepted these Terms.'}
              </p>
              <button onClick={() => navigate(isPrivacy ? '/terms' : '/register')}>
                {isPrivacy ? 'View Terms' : 'Accept and Register'}
              </button>
            </div>
          </div>
        </div>
      </main>

      <footer className="legal-footer">
        © 2026 Fee Flow Solutions · <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </footer>
    </div>
  );
}

export function TermsPage() {
  return <LegalPage type="terms" />;
}

export function PrivacyPage() {
  return <LegalPage type="privacy" />;
}

export default LegalPage;
