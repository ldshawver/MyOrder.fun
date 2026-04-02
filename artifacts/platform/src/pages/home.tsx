import { Link } from "wouter";
import { FlaskConical, ShieldCheck, Zap, ChevronRight } from "lucide-react";

const features = [
  {
    icon: FlaskConical,
    title: "Lab-Grade Ordering",
    desc: "Precision order management built for therapeutic compound workflows and clinical supply chains.",
  },
  {
    icon: ShieldCheck,
    title: "Compliance Ready",
    desc: "End-to-end audit trails, encrypted notes, and role-based access controls meet regulatory standards.",
  },
  {
    icon: Zap,
    title: "Real-Time Updates",
    desc: "Push notifications keep patients and lab technicians aligned at every step of the process.",
  },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans overflow-x-hidden">

      {/* ── Header ────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 px-5 md:px-10 py-4 flex items-center justify-between border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <Link href="/" className="flex items-center gap-3 group" data-testid="text-logo">
          <img
            src="/alavont-logo.png"
            alt="Alavont Therapeutics"
            className="w-9 h-9 object-contain group-hover:scale-105 transition-transform"
          />
          <div>
            <div className="font-bold text-sm tracking-widest text-foreground uppercase">ALAVONT</div>
            <div className="text-[10px] text-primary/80 tracking-widest uppercase font-medium">Therapeutics</div>
          </div>
        </Link>
        <div className="flex gap-3 items-center">
          <Link
            href="/sign-in"
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-2"
            data-testid="link-signin"
          >
            Sign In
          </Link>
          <Link
            href="/onboarding"
            className="text-sm font-semibold bg-primary text-primary-foreground px-5 py-2.5 rounded-xl hover:opacity-90 transition-all shadow-lg shadow-primary/20 flex items-center gap-1.5"
            data-testid="link-request-access"
          >
            Request Access
            <ChevronRight size={14} />
          </Link>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────── */}
      <main className="flex-1">
        <section className="relative flex flex-col items-center justify-center text-center px-6 pt-20 pb-28 md:pt-32 md:pb-40 overflow-hidden">
          {/* Background radial glow */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: "radial-gradient(ellipse 70% 50% at 50% 0%, hsl(214 90% 55% / 0.12), transparent)",
            }}
          />
          {/* Grid pattern overlay */}
          <div
            className="absolute inset-0 pointer-events-none opacity-[0.03]"
            style={{
              backgroundImage: "linear-gradient(hsl(214 90% 55%) 1px, transparent 1px), linear-gradient(90deg, hsl(214 90% 55%) 1px, transparent 1px)",
              backgroundSize: "48px 48px",
            }}
          />

          <div className="relative z-10 max-w-3xl mx-auto">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-semibold tracking-widest uppercase mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              Clinical Order Management Platform
            </div>

            <h1
              className="text-4xl sm:text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-[1.05]"
              data-testid="text-hero-title"
            >
              Precision at Every{" "}
              <span
                className="text-transparent bg-clip-text"
                style={{
                  backgroundImage: "linear-gradient(135deg, hsl(214 90% 70%), hsl(214 90% 55%), hsl(200 90% 65%))",
                }}
              >
                Step
              </span>
            </h1>

            <p
              className="text-base md:text-xl text-muted-foreground mb-10 max-w-xl mx-auto leading-relaxed font-light"
              data-testid="text-hero-subtitle"
            >
              Alavont Therapeutics' ordering platform delivers clinical-grade supply chain management with real-time tracking, lab notifications, and end-to-end compliance.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/onboarding"
                className="inline-flex items-center justify-center gap-2 text-base font-semibold bg-primary text-primary-foreground px-8 py-4 rounded-xl hover:opacity-90 transition-all shadow-xl shadow-primary/25"
                data-testid="link-hero-cta"
              >
                Apply for Access
                <ChevronRight size={18} />
              </Link>
              <Link
                href="/sign-in"
                className="inline-flex items-center justify-center gap-2 text-base font-medium border border-border/60 px-8 py-4 rounded-xl hover:bg-muted/30 transition-all"
              >
                Sign In
              </Link>
            </div>
          </div>
        </section>

        {/* ── Logo display ─────────────────────────────────────────── */}
        <section className="flex justify-center pb-16">
          <div className="relative">
            <img
              src="/alavont-logo.png"
              alt="Alavont Therapeutics"
              className="w-32 h-32 md:w-40 md:h-40 object-contain"
              style={{
                filter: "drop-shadow(0 0 40px hsl(214 90% 55% / 0.4)) drop-shadow(0 0 80px hsl(214 90% 55% / 0.15))",
              }}
            />
          </div>
        </section>

        {/* ── Features ─────────────────────────────────────────────── */}
        <section className="px-6 md:px-10 pb-24 max-w-5xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {features.map((feat) => {
              const Icon = feat.icon;
              return (
                <div
                  key={feat.title}
                  className="glass-card rounded-2xl p-6 space-y-4 card-hover-glow"
                >
                  <div className="w-11 h-11 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center">
                    <Icon size={20} className="text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-base mb-2">{feat.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{feat.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── CTA strip ────────────────────────────────────────────── */}
        <section className="mx-6 md:mx-10 mb-16 max-w-4xl lg:mx-auto">
          <div
            className="relative rounded-2xl overflow-hidden p-8 md:p-12 text-center"
            style={{
              background: "linear-gradient(135deg, hsl(214 90% 18%), hsl(220 60% 14%))",
              border: "1px solid hsl(214 90% 30% / 0.4)",
            }}
          >
            <div className="absolute inset-0 pointer-events-none" style={{
              background: "radial-gradient(ellipse 60% 80% at 50% 120%, hsl(214 90% 55% / 0.2), transparent)",
            }} />
            <div className="relative z-10">
              <h2 className="text-2xl md:text-3xl font-bold mb-3">Ready to get started?</h2>
              <p className="text-muted-foreground mb-8 max-w-md mx-auto">
                Join Alavont Therapeutics' secure ordering network. Your application is reviewed and approved by our team.
              </p>
              <Link
                href="/onboarding"
                className="inline-flex items-center gap-2 font-semibold text-sm bg-primary text-primary-foreground px-7 py-3.5 rounded-xl hover:opacity-90 transition-all shadow-xl shadow-primary/25"
              >
                Request Tenant Access
                <ChevronRight size={16} />
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ────────────────────────────────────────────────── */}
      <footer className="border-t border-border/40 px-6 md:px-10 py-8">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <img src="/alavont-logo.png" alt="Alavont" className="w-7 h-7 object-contain opacity-70" />
            <span className="text-sm text-muted-foreground">© {new Date().getFullYear()} Alavont Therapeutics. All rights reserved.</span>
          </div>
          <div className="flex gap-6 text-sm text-muted-foreground">
            <Link href="/onboarding" className="hover:text-foreground transition-colors">Apply</Link>
            <Link href="/sign-in" className="hover:text-foreground transition-colors">Sign In</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
