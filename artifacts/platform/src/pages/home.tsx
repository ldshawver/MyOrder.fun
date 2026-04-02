import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ShieldCheck, Lock, Cpu } from "lucide-react";

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*";

function useCipherText(finalText: string, startDelay = 0) {
  const [display, setDisplay] = useState(() => finalText.replace(/./g, "█"));
  const frameRef = useRef(0);

  useEffect(() => {
    let startTimer: ReturnType<typeof setTimeout>;
    startTimer = setTimeout(() => {
      let iteration = 0;
      const total = finalText.length * 6;
      const animate = () => {
        setDisplay(
          finalText
            .split("")
            .map((char, i) => {
              if (char === " ") return " ";
              if (iteration >= (i + 1) * 6) return char;
              return CHARS[Math.floor(Math.random() * CHARS.length)];
            })
            .join("")
        );
        iteration++;
        if (iteration < total) {
          frameRef.current = requestAnimationFrame(animate);
        } else {
          setDisplay(finalText);
        }
      };
      frameRef.current = requestAnimationFrame(animate);
    }, startDelay);

    return () => {
      clearTimeout(startTimer);
      cancelAnimationFrame(frameRef.current);
    };
  }, [finalText, startDelay]);

  return display;
}

export default function Home() {
  const [scanDone, setScanDone] = useState(false);
  const line1 = useCipherText("SECURE AI", 600);
  const line2 = useCipherText("ORDERING", 1000);
  const line3 = useCipherText("SYSTEM", 1400);

  useEffect(() => {
    const t = setTimeout(() => setScanDone(true), 1800);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="min-h-screen text-foreground flex flex-col font-sans overflow-x-hidden relative"
      style={{ background: "#040810" }}
    >
      {/* Scan line sweep */}
      <div
        className="pointer-events-none fixed inset-0 z-50"
        style={{
          background: "linear-gradient(to bottom, transparent 0%, hsl(214 90% 55% / 0.06) 50%, transparent 100%)",
          backgroundSize: "100% 4px",
        }}
      />
      {scanDone ? null : (
        <div
          className="pointer-events-none fixed left-0 right-0 z-50 h-0.5"
          style={{
            background: "linear-gradient(90deg, transparent, hsl(214 90% 60%), hsl(180 90% 60%), transparent)",
            boxShadow: "0 0 32px 8px hsl(214 90% 55% / 0.6)",
            animation: "scanSweep 1.6s ease-in-out forwards",
          }}
        />
      )}

      {/* CRT grid overlay */}
      <div
        className="pointer-events-none fixed inset-0 z-10 opacity-[0.025]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(214 90% 55%) 1px, transparent 1px), linear-gradient(90deg, hsl(214 90% 55%) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />

      {/* Radial glow */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, hsl(214 90% 55% / 0.10), transparent 70%)",
        }}
      />

      {/* Header */}
      <header className="relative z-20 sticky top-0 px-5 md:px-10 py-4 flex items-center justify-between border-b border-primary/10 bg-[#040810]/90 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <img
            src="/alavont-logo.png"
            alt="Alavont"
            className="w-9 h-9 object-contain"
            style={{ filter: "drop-shadow(0 0 10px hsl(214 90% 55% / 0.6))" }}
          />
          <div>
            <div className="font-bold text-sm tracking-widest uppercase text-foreground">ALAVONT</div>
            <div className="text-[9px] text-primary tracking-[0.3em] uppercase font-medium">THERAPEUTICS</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono text-emerald-400/80 tracking-widest">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            AES-256 ENCRYPTED
          </div>
          <Link
            href="/sign-in"
            className="text-xs font-semibold tracking-widest uppercase px-5 py-2.5 rounded-lg border border-primary/30 text-primary hover:bg-primary/10 transition-all"
            data-testid="link-signin"
          >
            Sign In
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center text-center px-6 py-24 md:py-36">
        {/* Invitation badge */}
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-primary/20 bg-primary/5 mb-10">
          <Lock size={11} className="text-primary" />
          <span className="text-[10px] font-mono tracking-[0.3em] text-primary uppercase">
            Invitation Only
          </span>
        </div>

        {/* Cipher hero title */}
        <div className="mb-8 font-black leading-none tracking-tighter select-none" style={{ fontFeatureSettings: '"tnum"' }}>
          <div
            className="text-5xl sm:text-7xl md:text-8xl lg:text-9xl"
            style={{
              background: "linear-gradient(135deg, #fff 0%, hsl(214 90% 70%) 50%, hsl(180 90% 65%) 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              fontVariantNumeric: "tabular-nums",
            }}
            data-testid="text-hero-title"
          >
            {line1}
          </div>
          <div
            className="text-5xl sm:text-7xl md:text-8xl lg:text-9xl"
            style={{
              background: "linear-gradient(135deg, hsl(214 90% 70%) 0%, hsl(200 90% 60%) 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {line2}
          </div>
          <div
            className="text-5xl sm:text-7xl md:text-8xl lg:text-9xl text-foreground/20"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {line3}
          </div>
        </div>

        <p
          className="text-sm md:text-base text-muted-foreground max-w-md mb-12 leading-relaxed font-light"
          data-testid="text-hero-subtitle"
        >
          A private, end-to-end encrypted ordering platform for trusted members only.
          Access is by invitation. All sessions are secured with military-grade encryption.
        </p>

        {/* Security badges */}
        <div className="flex flex-wrap items-center justify-center gap-3 mb-12">
          {[
            { icon: ShieldCheck, label: "AES-256 Encrypted" },
            { icon: Lock, label: "Zero Knowledge Sessions" },
            { icon: Cpu, label: "AI-Powered Ordering" },
          ].map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-primary/15 bg-primary/5 text-xs font-mono text-primary/80 tracking-wider"
            >
              <Icon size={12} />
              {label}
            </div>
          ))}
        </div>

        <Link
          href="/sign-in"
          className="inline-flex items-center gap-2 font-semibold text-sm bg-primary text-primary-foreground px-8 py-4 rounded-xl hover:opacity-90 transition-all shadow-2xl"
          style={{ boxShadow: "0 0 40px hsl(214 90% 55% / 0.4)" }}
          data-testid="link-hero-cta"
        >
          <Lock size={15} />
          Access Portal
        </Link>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-primary/10 px-6 py-6">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img src="/alavont-logo.png" alt="Alavont" className="w-6 h-6 object-contain opacity-50" />
            <span className="text-[11px] font-mono text-muted-foreground/50 tracking-widest uppercase">
              © {new Date().getFullYear()} Alavont Therapeutics
            </span>
          </div>
          <div className="text-[10px] font-mono text-muted-foreground/30 tracking-widest uppercase">
            Private · Encrypted · Invitation Only
          </div>
        </div>
      </footer>

      <style>{`
        @keyframes scanSweep {
          0%   { top: -2px; opacity: 1; }
          90%  { top: 100vh; opacity: 0.6; }
          100% { top: 100vh; opacity: 0; }
        }
      `}</style>
    </div>
  );
}
