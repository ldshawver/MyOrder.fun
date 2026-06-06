import { Link } from "wouter";
import { ArrowLeft, Shield, AlertTriangle, Eye, Trash2, Lock, FileText } from "lucide-react";

const EFFECTIVE_DATE = "April 8, 2026";

function Section({ number, title, icon: Icon, children }: { number: string; title: string; icon?: React.ElementType; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-sm font-bold tracking-[0.15em] uppercase mb-4 flex items-center gap-2" style={{ color: "#C0C0C0" }}>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded border" style={{ color: "#DC143C", borderColor: "rgba(220,20,60,0.3)", background: "rgba(220,20,60,0.06)" }}>{number}</span>
        {Icon && <Icon size={13} style={{ color: "#DC143C", flexShrink: 0 }} />}
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
      {title && <div className="font-semibold text-xs mb-1.5 uppercase tracking-wide" style={{ color: "#aaa" }}>{title}</div>}
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

function PrincipleCard({ icon: Icon, title, body }: { icon: React.ElementType; title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 p-4 rounded-xl border" style={{ borderColor: "rgba(220,20,60,0.12)", background: "rgba(220,20,60,0.03)" }}>
      <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: "rgba(220,20,60,0.1)", border: "1px solid rgba(220,20,60,0.2)" }}>
        <Icon size={13} style={{ color: "#DC143C" }} />
      </div>
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "#C0C0C0" }}>{title}</div>
        <div className="text-xs leading-relaxed" style={{ color: "#666" }}>{body}</div>
      </div>
    </div>
  );
}

export default function PrivacyPage() {
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
            <Shield size={14} style={{ color: "#DC143C" }} />
            <span className="text-xs font-mono tracking-wide" style={{ color: "#777" }}>PRIVACY POLICY · MYORDER.FUN</span>
          </div>
        </div>
        <div className="text-[10px] font-mono" style={{ color: "#444" }}>Effective {EFFECTIVE_DATE}</div>
      </header>

      <main className="relative z-10 max-w-3xl mx-auto px-6 py-12">

        {/* Title block */}
        <div className="mb-12 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border mb-5 font-mono text-[10px] tracking-[0.25em] uppercase" style={{ borderColor: "rgba(220,20,60,0.3)", color: "#DC143C", background: "rgba(220,20,60,0.06)" }}>
            <Lock size={10} />
            Privacy-First Architecture
          </div>
          <h1 className="text-2xl font-bold tracking-[0.1em] uppercase mb-3" style={{ color: "#C0C0C0" }}>
            Privacy Policy
          </h1>
          <p className="text-sm font-mono mb-1" style={{ color: "#555" }}>MyOrder.fun &nbsp;·&nbsp; Effective Date: {EFFECTIVE_DATE}</p>
        </div>

        {/* Section 1: Introduction */}
        <Section number="1" title="Introduction">
          <p>
            MyOrder.fun ("we," "us," or "our") is built with a privacy-first and security-first architecture.
            Unlike traditional platforms, we intentionally minimize data storage and retain only what is strictly
            necessary for real-time operation.
          </p>
          <p>
            This Privacy Policy explains how we collect, use, and handle your information while prioritizing
            data minimization, limited retention, and system security.
          </p>
          <p>By using MyOrder.fun, you agree to this Privacy Policy.</p>
        </Section>

        {/* Section 2: Core Principles */}
        <Section number="2" title="Core Privacy Principles">
          <p className="mb-4">MyOrder.fun operates under the following principles:</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <PrincipleCard icon={Eye} title="Minimal Data Collection" body="Only essential data is collected. We do not gather information beyond what is required to operate the service." />
            <PrincipleCard icon={Trash2} title="Ephemeral Data Storage" body="Data is deleted as soon as it is no longer operationally required. Order data is purged post-payment." />
            <PrincipleCard icon={Shield} title="User-Controlled Deletion" body="Users can permanently remove all their data. This action is irreversible and immediate." />
            <PrincipleCard icon={Lock} title="Security-First Design" body="All systems are designed to reduce attack surfaces, minimize exposure, and prevent unauthorized access." />
            <PrincipleCard icon={FileText} title="No Data Monetization" body="We do not sell, rent, broker, or exploit user data in any form, for any purpose." />
            <PrincipleCard icon={AlertTriangle} title="Legal Safety Valve" body="Limited retention may occur when required by law or court order. You will be notified where legally permitted." />
          </div>
        </Section>

        {/* Section 3: Information We Collect */}
        <Section number="3" title="Information We Collect">
          <Clause title="3.1 Account Information">
            <BulletList items={[
              "Name (if provided during onboarding)",
              "Email address",
              "Authentication credentials (securely hashed; never stored in plaintext)",
            ]} />
          </Clause>

          <Clause title="3.2 Transaction Data (Temporary)">
            <BulletList items={[
              "Order details and product selections",
              "Pricing snapshot at time of purchase",
              "Transaction status and completion record",
            ]} />
            <AlertBox icon={AlertTriangle} color="#FF6B00" title="Important — Ephemeral Order Data">
              All transaction and order data is automatically deleted immediately after payment is completed and
              processed, except where temporary retention is required for system integrity or fraud prevention.
              MyOrder.fun does not maintain long-term purchase histories.
            </AlertBox>
          </Clause>

          <Clause title="3.3 Technical & Security Data">
            <p className="mb-2">The following data is collected strictly for security and operational purposes:</p>
            <BulletList items={[
              "IP address",
              "Device and browser metadata",
              "Session identifiers",
              "Authentication and access logs (page views, timestamps)",
            ]} />
          </Clause>
        </Section>

        {/* Section 4: How We Use Information */}
        <Section number="4" title="How We Use Information">
          <p className="font-semibold text-xs uppercase tracking-wide mb-2" style={{ color: "#aaa" }}>We use data only to:</p>
          <BulletList items={[
            "Authenticate users and control access",
            "Process and complete orders",
            "Prevent fraud and detect abuse",
            "Maintain system security and integrity",
            "Enforce our Terms & Conditions including confidentiality obligations",
          ]} />
          <p className="mt-4 font-semibold text-xs uppercase tracking-wide mb-2" style={{ color: "#aaa" }}>We do NOT use your data for:</p>
          <BulletList items={[
            "Advertising or marketing profiling",
            "Behavioral analytics or tracking",
            "Data resale or brokering",
            "Any purpose beyond the above",
          ]} />
        </Section>

        {/* Section 5: Ephemeral Data & Deletion */}
        <Section number="5" title="Ephemeral Data & Deletion Policy" icon={Trash2}>
          <Clause title="5.1 Order Data Deletion">
            <p>Order history is not permanently stored. All order-related data is deleted immediately after successful payment processing. MyOrder.fun does not maintain long-term purchase histories beyond what is operationally required.</p>
          </Clause>

          <Clause title="5.2 Account Deletion (Full Erasure)">
            <p className="mb-2">When a user deletes their account:</p>
            <BulletList items={[
              "All associated personal data is permanently and irreversibly deleted",
              "No accessible user profile, order history, or identifying records remain",
              "Data is not retained for future recovery or re-association",
            ]} />
            <div className="mt-3 rounded-lg border px-4 py-3" style={{ borderColor: "rgba(220,20,60,0.2)", background: "rgba(220,20,60,0.04)" }}>
              <span className="text-xs font-bold uppercase tracking-wide" style={{ color: "#DC143C" }}>⚠ This action is permanent and irreversible.</span>
            </div>
          </Clause>

          <Clause title="5.3 Residual Technical Logs">
            <p className="mb-2">Limited system logs may temporarily exist for security auditing, abuse detection, and system diagnostics. These logs:</p>
            <BulletList items={[
              "Are minimized and regularly purged",
              "Do not contain unnecessary personal data",
              "Are not used to reconstruct user profiles or histories",
            ]} />
          </Clause>
        </Section>

        {/* Section 6: Private Infrastructure */}
        <Section number="6" title="Private Infrastructure">
          <p>
            MyOrder.fun is hosted on a privately controlled server environment, reducing reliance on third-party
            cloud providers and their associated data exposure risks.
          </p>
          <p>We limit exposure by:</p>
          <BulletList items={[
            "Minimizing external integrations and third-party dependencies",
            "Restricting administrative access to infrastructure",
            "Implementing strict security controls and network-level access controls",
          ]} />
        </Section>

        {/* Section 7: Security Practices */}
        <Section number="7" title="Security Practices" icon={Shield}>
          <p>We implement strong safeguards including:</p>
          <BulletList items={[
            "Encrypted communication (HTTPS/TLS) for all data in transit",
            "Secure, HTTP-only, SameSite cookies",
            "CSRF protection on all state-changing requests",
            "Rate limiting and abuse detection",
            "Strict server-side input validation and output encoding",
            "Object-level authorization controls (prevents IDOR/BOLA)",
            "Secure password hashing (Argon2id or equivalent)",
            "Minimal logging with redaction of sensitive data fields",
            "Session watermarking for content traceability and deterrence",
          ]} />
        </Section>

        {/* Section 8: User Responsibility */}
        <Section number="8" title="User Responsibility">
          <p>Security and privacy depend in part on responsible user behavior. You agree:</p>
          <BulletList items={[
            "Not to share your login credentials with any third party",
            "Not to allow unauthorized individuals to access the Platform through your account",
            "Not to record, screenshot, screen-share, or distribute Platform content",
            "To use secure, private devices and network connections",
          ]} />
          <p className="mt-3">We are not responsible for data exposure resulting from user negligence, credential sharing, or unauthorized recording or disclosure. Unauthorized disclosure is subject to liquidated damages as described in our Terms &amp; Conditions.</p>
        </Section>

        {/* Section 9: Data Sharing */}
        <Section number="9" title="Data Sharing">
          <p>We do not sell or distribute user data. Limited data may be shared only when strictly necessary:</p>
          <BulletList items={[
            "With payment providers to process and complete transactions",
            "When required by applicable law, court order, or regulatory obligation",
          ]} />
        </Section>

        {/* Section 10: Cookies & Sessions */}
        <Section number="10" title="Cookies & Sessions">
          <p>We use cookies strictly for authentication, security, and session management. We do not use tracking cookies, advertising cookies, or any analytics cookies that persist beyond your session.</p>
        </Section>

        {/* Section 11: Dynamic Updates */}
        <Section number="11" title="Privacy Policy Updates">
          <p>
            Because MyOrder.fun continuously improves its security architecture, this Privacy Policy may be
            updated to reflect changes in system design, data handling, or security practices. Updates may be
            implemented as features evolve or security improvements are deployed.
          </p>
          <p>Continued use of the Platform constitutes acceptance of the current version of this Policy.</p>
        </Section>

        {/* Section 12: Data Breach Disclaimer */}
        <Section number="12" title="Data Breach Disclaimer">
          <p>While we use strong security measures, no system is completely immune to risk. We are not liable for breaches resulting from:</p>
          <BulletList items={[
            "User actions, negligence, or credential sharing",
            "Compromised personal devices or insecure network environments",
            "Failures of external services outside our direct control",
          ]} />
        </Section>

        {/* Section 13: California Privacy Rights */}
        <Section number="13" title="Your Rights (California / CCPA)">
          <p>If you are a California resident, you may request:</p>
          <BulletList items={[
            "Access to your personal data (if it exists at the time of request)",
            "Deletion of your personal data",
            "Correction of inaccurate personal data",
          ]} />
          <p className="mt-3">
            Due to our ephemeral data model, data may already be deleted at the time of your request. We will
            confirm deletion or provide the data that is available within 45 days of your verified request.
          </p>
        </Section>

        {/* Section 14: Contact */}
        <Section number="14" title="Contact">
          <p>For privacy or security inquiries, contact the Platform operator through your designated account representative or the administrative contact on file for your organization.</p>
          <div className="mt-4 rounded-xl border p-5" style={{ borderColor: "rgba(220,20,60,0.15)", background: "rgba(220,20,60,0.04)" }}>
            <div className="text-xs font-mono" style={{ color: "#777" }}>MyOrder.fun &nbsp;·&nbsp; Lucifer Cruz Adult Boutique &nbsp;·&nbsp; Alavont Therapeutics</div>
            <div className="text-xs font-mono mt-1" style={{ color: "#444" }}>Privacy &amp; Security Office &nbsp;·&nbsp; Contact via Platform administrator</div>
          </div>
        </Section>

        {/* Cross-link to Terms */}
        <div className="mt-8 rounded-xl border p-5 flex items-center justify-between" style={{ borderColor: "rgba(220,20,60,0.12)", background: "rgba(220,20,60,0.03)" }}>
          <div>
            <div className="text-xs font-bold uppercase tracking-wide mb-1" style={{ color: "#C0C0C0" }}>Terms &amp; Conditions</div>
            <div className="text-xs" style={{ color: "#666" }}>Read the full Terms including NDA and Liquidated Damages clauses.</div>
          </div>
          <Link
            href="/terms-of-service"
            className="flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-lg border transition-colors flex-shrink-0"
            style={{ borderColor: "rgba(220,20,60,0.25)", color: "#DC143C" }}
          >
            <FileText size={12} />
            View Terms
          </Link>
        </div>

        {/* Footer */}
        <div className="mt-14 pt-8 border-t text-center space-y-2" style={{ borderColor: "rgba(220,20,60,0.08)" }}>
          <div className="text-[10px] font-mono" style={{ color: "#333" }}>MYORDER.FUN &nbsp;·&nbsp; LUCIFER CRUZ ADULT BOUTIQUE &nbsp;·&nbsp; ALAVONT THERAPEUTICS</div>
          <div className="text-[10px] font-mono" style={{ color: "#2a2a2a" }}>Effective {EFFECTIVE_DATE} &nbsp;·&nbsp; All rights reserved</div>
          <div className="mt-4">
            <Link href="/" className="inline-flex items-center gap-2 text-xs font-mono px-4 py-2 rounded-lg border transition-colors" style={{ borderColor: "rgba(220,20,60,0.2)", color: "#555" }}>
              <ArrowLeft size={12} />
              Return to Platform
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
