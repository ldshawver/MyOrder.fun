import { Link } from "wouter";
import { ArrowLeft, ShieldCheck, AlertTriangle, Lock, FileText } from "lucide-react";

const EFFECTIVE_DATE = "April 8, 2026";

function Section({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-sm font-bold tracking-[0.15em] uppercase mb-4 flex items-center gap-2" style={{ color: "#C0C0C0" }}>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded border" style={{ color: "#DC143C", borderColor: "rgba(220,20,60,0.3)", background: "rgba(220,20,60,0.06)" }}>{number}</span>
        {title}
      </h2>
      <div className="text-sm leading-relaxed space-y-3" style={{ color: "#888" }}>
        {children}
      </div>
    </section>
  );
}

function Clause({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="pl-4 border-l-2 my-3" style={{ borderColor: "rgba(220,20,60,0.2)" }}>
      {title && <div className="font-semibold text-xs mb-1 uppercase tracking-wide" style={{ color: "#aaa" }}>{title}</div>}
      <div>{children}</div>
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5 mt-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span className="mt-1.5 w-1 h-1 rounded-full flex-shrink-0" style={{ background: "#DC143C" }} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function AlertBox({ icon: Icon, color, title, children }: { icon: React.ElementType; color: string; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-5 my-6" style={{ borderColor: `${color}40`, background: `${color}08` }}>
      <div className="flex items-start gap-3">
        <Icon size={16} style={{ color, flexShrink: 0, marginTop: 2 }} />
        <div>
          <div className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color }}>{title}</div>
          <div className="text-sm leading-relaxed" style={{ color: "#999" }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

export default function TermsPage() {
  return (
    <div className="min-h-screen font-sans" style={{ background: "#0A0000" }}>
      {/* Scan lines */}
      <div className="pointer-events-none fixed inset-0 z-0 opacity-[0.015]" style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(180,0,0,1) 4px)" }} />

      {/* Header */}
      <header className="sticky top-0 z-30 border-b px-6 py-4 flex items-center justify-between backdrop-blur-sm" style={{ borderColor: "rgba(220,20,60,0.12)", background: "rgba(10,0,0,0.9)" }}>
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2 text-xs font-mono transition-colors" style={{ color: "#555" }}>
            <ArrowLeft size={14} />
            Back
          </Link>
          <div className="w-px h-4" style={{ background: "rgba(220,20,60,0.2)" }} />
          <div className="flex items-center gap-2">
            <FileText size={14} style={{ color: "#DC143C" }} />
            <span className="text-xs font-mono tracking-wide" style={{ color: "#777" }}>LEGAL · MYORDER.FUN</span>
          </div>
        </div>
        <div className="text-[10px] font-mono" style={{ color: "#444" }}>Effective {EFFECTIVE_DATE}</div>
      </header>

      <main className="relative z-10 max-w-3xl mx-auto px-6 py-12">

        {/* Title block */}
        <div className="mb-12 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border mb-5 font-mono text-[10px] tracking-[0.25em] uppercase" style={{ borderColor: "rgba(220,20,60,0.3)", color: "#DC143C", background: "rgba(220,20,60,0.06)" }}>
            <Lock size={10} />
            Confidential Platform Document
          </div>
          <h1 className="text-2xl font-bold tracking-[0.1em] uppercase mb-3" style={{ color: "#C0C0C0" }}>
            Terms &amp; Conditions
          </h1>
          <p className="text-sm font-mono" style={{ color: "#555" }}>MyOrder.fun &nbsp;·&nbsp; Effective Date: {EFFECTIVE_DATE}</p>
        </div>

        {/* NDA Banner */}
        <AlertBox icon={ShieldCheck} color="#DC143C" title="Non-Disclosure Acknowledgment (NDA)">
          By accessing or using this Platform, you enter into a binding non-disclosure obligation. All content,
          workflows, pricing logic, product data, and operational information visible within the Platform is
          strictly confidential and proprietary to Alavont Therapeutics / Lucifer Cruz Adult Boutique. You may
          not record, screenshot, screen-share, reproduce, or disclose any portion of this Platform to any
          unauthorized party. This obligation survives account termination and continues indefinitely.
        </AlertBox>

        {/* Liquidated Damages Banner */}
        <AlertBox icon={AlertTriangle} color="#FF6B00" title="⚠ Security Violation = Liquidated Damages">
          Unauthorized disclosure, recording, or distribution of Platform content constitutes a material breach
          of these Terms. You agree that the actual damages caused by such a breach would be difficult to
          calculate and, as a consequence, you agree to pay liquidated damages of <strong style={{ color: "#FF6B00" }}>$5,000 USD per individual
          incident</strong> of unauthorized disclosure, screenshot, recording, or distribution. This amount is not
          a penalty but a reasonable pre-estimate of harm. Additional legal action, injunctive relief, and
          recovery of attorney's fees may also be pursued.
        </AlertBox>

        <div className="my-8 border-t" style={{ borderColor: "rgba(220,20,60,0.08)" }} />

        {/* ── TERMS ─────────────────────────────────────────────────── */}
        <Section number="1" title="Acceptance of Terms">
          <p>
            By accessing or using MyOrder.fun ("Platform," "Service"), you agree to be legally bound by these Terms
            and Conditions. If you do not agree, do not use the Platform.
          </p>
          <p>
            This Platform is designed with security as a core priority, and your compliance with these Terms is
            essential to maintaining that security. Your use of the Platform constitutes acknowledgment that you
            have read, understood, and agreed to be bound by these Terms.
          </p>
        </Section>

        <Section number="2" title="Eligibility">
          <p>To use this Platform, you must:</p>
          <BulletList items={[
            "Be at least 18 years of age",
            "Have full legal authority to enter into binding agreements",
            "Use the Platform only for lawful purposes in your jurisdiction",
            "Have received authorized access credentials from the Platform operator",
          ]} />
        </Section>

        <Section number="3" title="Account Security & Confidentiality">
          <Clause title="3.1 Credential Responsibility">
            <p>You are fully responsible for maintaining the confidentiality of your login credentials and all activity that occurs under your account. You must not share credentials with any third party or allow unauthorized individuals to access the Platform through your account.</p>
          </Clause>

          <Clause title="3.2 Non-Disclosure & Confidentiality (BINDING)">
            <p className="mb-2">The Platform contains sensitive, proprietary, and restricted business information. By accessing the Platform, you explicitly agree to the following obligations, which constitute a binding non-disclosure agreement:</p>
            <p className="mb-2 font-semibold text-xs uppercase tracking-wide" style={{ color: "#DC143C" }}>You are strictly prohibited from:</p>
            <BulletList items={[
              "Taking screenshots, screen recordings, or photographs of any Platform content",
              "Using screen-mirroring, casting, or remote access tools to share Platform views",
              "Sharing, distributing, forwarding, or disclosing any content, data, pricing, or workflows",
              "Allowing unauthorized individuals to view the Platform over your shoulder or otherwise",
              "Exposing internal features, logic, pricing, product data, or operational information",
              "Discussing or describing Platform functionality to unauthorized parties",
            ]} />
            <p className="mt-3">Violation of this section may result in immediate account termination, legal action, and financial liability including the liquidated damages described above.</p>
          </Clause>

          <Clause title="3.3 Screenshot Deterrence">
            <p>The Platform actively embeds session-identifying information (including your email address and session metadata) as visual watermarks within authenticated pages. This information is recorded in server-side access logs. Any screenshot or recording of Platform content will contain identifying information traceable directly to your account.</p>
          </Clause>

          <Clause title="3.4 Device & Network Responsibility">
            <p>You are responsible for using secure, private devices and network connections when accessing the Platform. We are not liable for breaches caused by your use of compromised devices, shared computers, or insecure networks.</p>
          </Clause>
        </Section>

        <Section number="4" title="Session Monitoring & Access Logging">
          <p>
            By accessing the Platform, you consent to server-side logging of your access patterns, including but
            not limited to: pages visited, timestamps, IP addresses, device metadata, session durations, and
            navigation behavior. These logs are used for security monitoring, anomaly detection, and enforcement
            of these Terms. Logs are retained in accordance with our data retention policy.
          </p>
        </Section>

        <Section number="5" title="Acceptable Use">
          <p>You agree NOT to:</p>
          <BulletList items={[
            "Attempt to bypass, circumvent, or disable security controls",
            "Perform reverse engineering, decompilation, or code inspection of the Platform",
            "Exploit bugs, race conditions, or logic vulnerabilities",
            "Attempt unauthorized access via IDOR, privilege escalation, or parameter tampering",
            "Use automation, scraping bots, or unauthorized API calls",
            "Abuse APIs or attempt to overload Platform infrastructure",
            "Record, export, or exfiltrate data beyond your authorized scope",
          ]} />
        </Section>

        <Section number="6" title="Orders, Pricing & Transactions">
          <BulletList items={[
            "All pricing, totals, taxes, and fees are calculated server-side and are authoritative",
            "Client-side displayed values are informational only and non-binding",
            "Orders are subject to availability, validation, and fraud checks",
            "We reserve the right to cancel suspicious transactions, refuse service, or correct pricing errors",
          ]} />
        </Section>

        <Section number="7" title="Payments">
          <p>Payments are processed through third-party payment providers. We do not store raw card data. You agree to the terms of the applicable payment processor. We are not liable for payment processor outages or external fraud outside our direct control.</p>
        </Section>

        <Section number="8" title="Account Suspension & Termination">
          <p>We may suspend or terminate your account immediately and without notice for:</p>
          <BulletList items={[
            "Any violation of these Terms, particularly the confidentiality obligations",
            "Security risks or suspicious behavior",
            "Unauthorized access attempts",
            "Any conduct that threatens the integrity or security of the Platform",
          ]} />
        </Section>

        <Section number="9" title="Intellectual Property">
          <p>All Platform content, systems, workflows, pricing logic, product catalogs, and operational data are proprietary and protected by applicable intellectual property law. You may not copy, reproduce, reverse engineer, or redistribute any portion of the Platform.</p>
        </Section>

        <Section number="10" title="Liquidated Damages">
          <p>
            Given the difficulty of calculating actual damages arising from unauthorized disclosure of Platform
            content, the parties agree that liquidated damages of <strong style={{ color: "#C0C0C0" }}>$5,000 USD per incident</strong> represent
            a reasonable and genuine pre-estimate of loss. This applies to each individual act of:
          </p>
          <BulletList items={[
            "Unauthorized screenshot or screen recording",
            "Sharing Platform content with unauthorized parties",
            "Disclosing pricing, product, or workflow information",
            "Any other breach of the confidentiality obligations in Section 3",
          ]} />
          <p className="mt-3">
            These liquidated damages are in addition to, and not in lieu of, any injunctive relief or other
            legal remedies available. The Platform operator additionally reserves the right to pursue recovery
            of attorney's fees and court costs in any enforcement action.
          </p>
        </Section>

        <Section number="11" title="Limitation of Liability">
          <p>To the fullest extent permitted by applicable law, we are not liable for: unauthorized access due to user negligence or credential sharing; data exposure caused by user actions; or indirect, incidental, or consequential damages arising from Platform use.</p>
        </Section>

        <Section number="12" title="Indemnification">
          <p>You agree to indemnify, defend, and hold harmless MyOrder.fun, Alavont Therapeutics, and Lucifer Cruz Adult Boutique and their operators from any claims, liabilities, damages, or expenses (including attorney's fees) arising from your misuse of the Platform, security breaches caused by your actions, or violations of these Terms.</p>
        </Section>

        <Section number="13" title="Modifications">
          <p>We may update these Terms at any time. Continued use of the Platform after an update constitutes acceptance of the revised Terms. Material changes will be communicated via in-platform notification.</p>
        </Section>

        <Section number="14" title="Governing Law">
          <p>These Terms are governed by the laws of the State of California, without regard to conflict-of-law principles. Any dispute shall be resolved exclusively in the courts of California.</p>
        </Section>

        <div className="my-10 border-t" style={{ borderColor: "rgba(220,20,60,0.08)" }} />

        {/* ── PRIVACY POLICY ────────────────────────────────────────── */}
        <div className="mb-8 text-center">
          <h1 className="text-xl font-bold tracking-[0.1em] uppercase mb-2" style={{ color: "#C0C0C0" }}>Privacy Policy</h1>
          <p className="text-sm font-mono" style={{ color: "#555" }}>MyOrder.fun &nbsp;·&nbsp; Effective Date: {EFFECTIVE_DATE}</p>
        </div>

        <Section number="P1" title="Overview">
          <p>MyOrder.fun is built with a security-first architecture. We collect only what is necessary and protect it aggressively. This Privacy Policy explains what data we collect, how we use it, and your rights.</p>
        </Section>

        <Section number="P2" title="Information We Collect">
          <Clause title="Account Data">
            Name, email address, and hashed login credentials (secured using industry-standard algorithms).
          </Clause>
          <Clause title="Transaction Data">
            Orders, items, pricing snapshots, and timestamps associated with your account activity.
          </Clause>
          <Clause title="Technical & Security Data">
            IP address, device and browser metadata, session identifiers, page access patterns, and security monitoring logs.
          </Clause>
          <Clause title="What We Do NOT Collect">
            Full payment card data or sensitive financial credentials. Payment data is handled exclusively by our third-party payment processor.
          </Clause>
        </Section>

        <Section number="P3" title="How We Use Your Data">
          <BulletList items={[
            "Authentication, access control, and identity verification",
            "Order processing and transaction management",
            "Fraud detection and prevention",
            "Security monitoring, anomaly detection, and access pattern analysis",
            "Enforcement of these Terms and our confidentiality obligations",
          ]} />
        </Section>

        <Section number="P4" title="Security Practices">
          <BulletList items={[
            "HTTP-only, Secure session cookies",
            "CSRF protection and rate limiting",
            "Encrypted data transmission (HTTPS/TLS)",
            "Strict authorization and access control",
            "Session watermarking for content traceability",
            "Server-side access logging with retention for security investigations",
          ]} />
        </Section>

        <Section number="P5" title="Data Retention">
          <p>We retain data only as long as necessary for operational purposes, legal obligations, and security investigations. Access logs are retained for a minimum of 90 days for security monitoring purposes.</p>
        </Section>

        <Section number="P6" title="Data Sharing">
          <p>We do not sell your personal data. We only share data with: payment processors (for transaction processing only), and legal or regulatory authorities when required by applicable law or court order.</p>
        </Section>

        <Section number="P7" title="Cookies & Sessions">
          <p>We use secure, HTTP-only session cookies strictly for authentication and security. We do not use advertising or tracking cookies.</p>
        </Section>

        <Section number="P8" title="Your Rights (California / CCPA)">
          <p>If you are a California resident, you may: request access to your personal data, request deletion (subject to legal retention requirements), and request correction of inaccurate data. To exercise these rights, contact us via the information below.</p>
        </Section>

        <Section number="P9" title="Changes to This Policy">
          <p>We may update this Privacy Policy at any time. Continued use of the Platform constitutes acceptance of the revised Policy.</p>
        </Section>

        <Section number="P10" title="Contact">
          <p>For privacy, security, or legal inquiries: contact the Platform operator through your designated account representative or the administrative contact on file for your organization.</p>
        </Section>

        {/* Footer */}
        <div className="mt-14 pt-8 border-t text-center space-y-2" style={{ borderColor: "rgba(220,20,60,0.08)" }}>
          <div className="text-[10px] font-mono" style={{ color: "#333" }}>MYORDER.FUN &nbsp;·&nbsp; LUCIFER CRUZ ADULT BOUTIQUE &nbsp;·&nbsp; ALAVONT THERAPEUTICS</div>
          <div className="text-[10px] font-mono" style={{ color: "#2a2a2a" }}>Effective {EFFECTIVE_DATE} &nbsp;·&nbsp; All rights reserved</div>
          <div className="mt-4">
            <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link href="/privacy" className="inline-flex items-center gap-2 text-xs font-mono px-4 py-2 rounded-lg border transition-colors" style={{ borderColor: "rgba(220,20,60,0.2)", color: "#DC143C" }}>
              Privacy Policy →
            </Link>
            <Link href="/" className="inline-flex items-center gap-2 text-xs font-mono px-4 py-2 rounded-lg border transition-colors" style={{ borderColor: "rgba(220,20,60,0.2)", color: "#555" }}>
              <ArrowLeft size={12} />
              Return to Platform
            </Link>
          </div>
          </div>
        </div>
      </main>
    </div>
  );
}
