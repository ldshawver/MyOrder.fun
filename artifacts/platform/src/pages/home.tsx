import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Lock, ExternalLink } from "lucide-react";

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
  const l1 = useCipherText("LUCIFER", 300);
  const l2 = useCipherText("CRUZ", 700);

  useEffect(() => {
    const t = setTimeout(() => setScanDone(true), 1600);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="min-h-screen flex flex-col font-sans overflow-x-hidden relative"
      style={{ background: "#0A0000" }}
    >
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
      <header className="relative z-30 flex items-center justify-between px-6 py-5 border-b" style={{ borderColor: "rgba(220,20,60,0.15)" }}>
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-xs"
            style={{ background: "linear-gradient(135deg, #DC143C, #8B0000)", color: "#fff", letterSpacing: "0.05em" }}
          >
            LC
          </div>
          <div>
            <div className="font-bold text-sm tracking-[0.15em]" style={{ color: "#C0C0C0" }}>LUCIFER CRUZ</div>
            <div className="text-[9px] font-medium tracking-[0.3em] uppercase" style={{ color: "#8B0000" }}>Private Access</div>
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
      <main className="relative z-20 flex-1 flex flex-col items-center justify-center px-6 py-20 text-center">
        {/* Glow orb */}
        <div
          className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 rounded-full pointer-events-none"
          style={{
            background: "radial-gradient(circle, rgba(220,20,60,0.12) 0%, transparent 70%)",
            filter: "blur(40px)",
          }}
        />

        <div className="relative space-y-2 mb-10">
          <div
            className="font-black tracking-[0.3em] leading-none select-none"
            style={{
              fontSize: "clamp(3rem, 12vw, 8rem)",
              background: "linear-gradient(135deg, #DC143C 0%, #C0C0C0 50%, #DC143C 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              textShadow: "none",
              filter: "drop-shadow(0 0 30px rgba(220,20,60,0.4))",
            }}
          >
            {l1}
          </div>
          <div
            className="font-black tracking-[0.5em] leading-none select-none"
            style={{
              fontSize: "clamp(3rem, 12vw, 8rem)",
              background: "linear-gradient(135deg, #C0C0C0 0%, #DC143C 50%, #C0C0C0 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              filter: "drop-shadow(0 0 20px rgba(192,192,192,0.3))",
            }}
          >
            {l2}
          </div>
        </div>

        <p className="text-sm font-mono mb-10 max-w-sm leading-relaxed" style={{ color: "#888" }}>
          A private, invitation-only ordering platform.<br />Access is by appointment only.
        </p>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row gap-3 items-center">
          <Link
            href="/sign-in"
            className="flex items-center gap-2 text-sm font-bold px-8 py-3.5 rounded-xl transition-all"
            style={{
              background: "linear-gradient(135deg, #DC143C, #8B0000)",
              color: "#fff",
              boxShadow: "0 8px 32px rgba(220,20,60,0.4)",
              letterSpacing: "0.08em",
            }}
            data-testid="link-access-portal"
          >
            <Lock size={14} />
            ACCESS PORTAL
          </Link>
          <Link
            href="/onboarding"
            className="flex items-center gap-2 text-xs font-semibold px-6 py-3.5 rounded-xl border transition-all"
            style={{ borderColor: "rgba(192,192,192,0.15)", color: "#888", letterSpacing: "0.08em" }}
            data-testid="link-request-access"
          >
            REQUEST INVITATION
          </Link>
        </div>

        {/* Divider */}
        <div className="mt-20 flex items-center gap-6 w-full max-w-xs">
          <div className="flex-1 h-px" style={{ background: "rgba(220,20,60,0.15)" }} />
          <div className="text-[10px] font-mono tracking-[0.3em]" style={{ color: "#555" }}>ALAVONT</div>
          <div className="flex-1 h-px" style={{ background: "rgba(220,20,60,0.15)" }} />
        </div>
        <p className="mt-4 text-xs font-mono" style={{ color: "#444" }}>Therapeutics Division · Private Network</p>
      </main>

      {/* Corner decoration */}
      <div className="fixed bottom-6 right-6 z-20 text-[9px] font-mono space-y-1 text-right" style={{ color: "#333" }}>
        <div>SYS://SECURE</div>
        <div>ENC: AES-256</div>
        <div>AUTH: REQUIRED</div>
      </div>
    </div>
  );
}
