import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Lock, Sparkles } from "lucide-react";

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*";

function useCipherText(finalText: string, startDelay = 0) {
  const [display, setDisplay] = useState(() => finalText.replace(/./g, "█"));
  const frameRef = useRef(0);

  useEffect(() => {
    const startTimer = setTimeout(() => {
      let iteration = 0;
      const total = finalText.length * 5;
      const animate = () => {
        setDisplay(
          finalText.split("").map((char, i) => {
            if (char === " ") return " ";
            if (iteration >= (i + 1) * 5) return char;
            return CHARS[Math.floor(Math.random() * CHARS.length)];
          }).join("")
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
    return () => { clearTimeout(startTimer); cancelAnimationFrame(frameRef.current); };
  }, [finalText, startDelay]);

  return display;
}

export default function Home() {
  const [scanDone, setScanDone] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const tagline = useCipherText("ADULT BOUTIQUE", 900);

  useEffect(() => {
    const t = setTimeout(() => setScanDone(true), 1600);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="min-h-screen flex flex-col font-sans overflow-x-hidden relative"
      style={{ background: "#0A0000" }}
    >
      <style>{`
        @keyframes scanSweep {
          from { top: -4px; }
          to { top: 100vh; }
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Crimson scan-line overlay */}
      <div
        className="pointer-events-none fixed inset-0 z-10"
        style={{
          backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(180,0,0,0.015) 4px)",
        }}
      />

      {/* Scan sweep */}
      {!scanDone && (
        <div
          className="pointer-events-none fixed left-0 right-0 z-20 h-0.5"
          style={{
            background: "linear-gradient(90deg, transparent, #DC143C, #C0C0C0, transparent)",
            boxShadow: "0 0 40px 12px rgba(220,20,60,0.5)",
            animation: "scanSweep 1.5s ease-in-out forwards",
          }}
        />
      )}

      {/* Noise texture */}
      <div
        className="pointer-events-none fixed inset-0 z-10 opacity-[0.03]"
        style={{
          backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E\")",
          backgroundRepeat: "repeat",
          backgroundSize: "128px",
        }}
      />

      {/* Header */}
      <header className="relative z-30 flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "rgba(220,20,60,0.15)" }}>
        <div className="flex items-center gap-3">
          <img
            src="/lc-icon.png"
            alt="Lucifer Cruz"
            className="w-9 h-9 object-contain"
            style={{ filter: "invert(1) brightness(1.2)" }}
          />
          <div>
            <div className="font-bold text-sm tracking-[0.15em]" style={{ color: "#C0C0C0" }}>LUCIFER CRUZ</div>
            <div className="text-[9px] font-medium tracking-[0.3em] uppercase" style={{ color: "#8B0000" }}>Adult Boutique · 18+</div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono px-3 py-1.5 rounded-full border" style={{ color: "#C0C0C0", borderColor: "rgba(192,192,192,0.15)", background: "rgba(192,192,192,0.03)" }}>
            <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "#DC143C" }} />
            ENCRYPTED
          </div>
          <Link
            href="/sign-in"
            className="flex items-center gap-2 text-xs font-bold px-5 py-2.5 rounded-xl transition-all tracking-wide"
            style={{ background: "linear-gradient(135deg, #DC143C, #8B0000)", color: "#fff", boxShadow: "0 4px 20px rgba(220,20,60,0.35)" }}
            data-testid="link-sign-in"
          >
            <Lock size={12} />
            SIGN IN
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="relative z-20 flex-1 flex flex-col items-center justify-center px-6 py-16 text-center">
        {/* Glow orb */}
        <div
          className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full pointer-events-none"
          style={{
            background: "radial-gradient(circle, rgba(220,20,60,0.12) 0%, transparent 70%)",
            filter: "blur(40px)",
          }}
        />

        {/* Logo */}
        <div className="relative mb-8">
          <img
            src="/lc-logo.webp"
            alt="Lucifer Cruz"
            className="w-auto object-contain"
            style={{
              height: "clamp(60px, 14vw, 120px)",
              mixBlendMode: "screen",
              filter: "drop-shadow(0 0 30px rgba(220,20,60,0.5))",
            }}
          />
        </div>

        {/* Cipher tagline */}
        <div
          className="font-mono tracking-[0.4em] mb-3 select-none"
          style={{
            fontSize: "clamp(0.75rem, 2.5vw, 1.1rem)",
            color: "#DC143C",
            letterSpacing: "0.35em",
          }}
        >
          {tagline}
        </div>

        {/* 18+ badge */}
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border mb-8 font-mono text-[10px] tracking-[0.25em] uppercase"
          style={{ borderColor: "rgba(220,20,60,0.35)", color: "#DC143C", background: "rgba(220,20,60,0.06)" }}
        >
          <Sparkles size={10} />
          Adults Only · 18+
        </div>

        {/* Boutique tagline */}
        <p className="mb-2 font-semibold tracking-wide" style={{ color: "#C0C0C0", fontSize: "clamp(1rem, 3vw, 1.3rem)" }}>
          Premium Curated Adult Products
        </p>
        <p className="text-sm mb-10 max-w-md leading-relaxed" style={{ color: "#666", fontFamily: "serif", fontStyle: "italic" }}>
          Discreet, luxurious, delivered. Browse our exclusive selection
          of pleasure goods, intimate accessories, and wellness products.
        </p>

        {/* Age gate checkbox */}
        <label className="flex items-center gap-3 mb-8 cursor-pointer group">
          <div
            className="w-5 h-5 rounded flex items-center justify-center border transition-all flex-shrink-0"
            style={{
              borderColor: ageConfirmed ? "#DC143C" : "rgba(220,20,60,0.3)",
              background: ageConfirmed ? "rgba(220,20,60,0.2)" : "transparent",
            }}
          >
            {ageConfirmed && (
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4L3.5 6.5L9 1" stroke="#DC143C" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
          <input
            type="checkbox"
            className="sr-only"
            checked={ageConfirmed}
            onChange={e => setAgeConfirmed(e.target.checked)}
          />
          <span className="text-xs" style={{ color: "#777" }}>
            I confirm I am 18 years of age or older and wish to enter
          </span>
        </label>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row gap-3 items-center">
          <Link
            href={ageConfirmed ? "/sign-in" : "#"}
            className="flex items-center gap-2 text-sm font-bold px-8 py-3.5 rounded-xl transition-all"
            style={{
              background: ageConfirmed
                ? "linear-gradient(135deg, #DC143C, #8B0000)"
                : "rgba(100,0,0,0.3)",
              color: ageConfirmed ? "#fff" : "#555",
              boxShadow: ageConfirmed ? "0 8px 32px rgba(220,20,60,0.4)" : "none",
              letterSpacing: "0.1em",
              cursor: ageConfirmed ? "pointer" : "not-allowed",
              pointerEvents: ageConfirmed ? "auto" : "none",
            }}
            data-testid="link-access-portal"
          >
            <Lock size={14} />
            ENTER THE BOUTIQUE
          </Link>
          <Link
            href="/onboarding"
            className="flex items-center gap-2 text-xs font-semibold px-6 py-3.5 rounded-xl border transition-all"
            style={{ borderColor: "rgba(192,192,192,0.15)", color: "#888", letterSpacing: "0.08em" }}
            data-testid="link-request-access"
          >
            BECOME A MEMBER
          </Link>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-20 border-t py-5 px-6 flex items-center justify-between" style={{ borderColor: "rgba(220,20,60,0.08)" }}>
        <div className="text-[10px] font-mono" style={{ color: "#333" }}>
          ADULTS ONLY · 18+ TO ENTER
        </div>
        <div className="text-[10px] font-mono" style={{ color: "#333" }}>
          DISCREET · SECURE · CURATED
        </div>
      </footer>
    </div>
  );
}
