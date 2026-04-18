import { useState, useRef, useEffect } from "react";
import { ShieldCheck, AlertTriangle, Lock, ExternalLink } from "lucide-react";
import { Link } from "wouter";

const NDA_VERSION = "v2-2026-04";
const STORAGE_KEY = `nda_accepted_${NDA_VERSION}`;

export function useNdaAccepted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function markNdaAccepted() {
  try {
    localStorage.setItem(STORAGE_KEY, "true");
    localStorage.setItem(`nda_accepted_at`, new Date().toISOString());
  } catch { /* ignore storage errors */ }
}

interface NdaModalProps {
  userEmail: string;
  onAccept: () => void;
}

export default function NdaModal({ userEmail, onAccept }: NdaModalProps) {
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const [checked, setChecked] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      if (atBottom) setScrolledToBottom(true);
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  function handleAccept() {
    if (!checked) return;
    markNdaAccepted();
    onAccept();
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.92)", backdropFilter: "blur(8px)" }}>
      {/* Scan lines */}
      <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(180,0,0,0.012) 4px)" }} />

      <div className="relative w-full max-w-lg rounded-2xl border overflow-hidden shadow-2xl" style={{ borderColor: "rgba(220,20,60,0.25)", background: "#0D0000" }}>
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b" style={{ borderColor: "rgba(220,20,60,0.12)" }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "rgba(220,20,60,0.12)", border: "1px solid rgba(220,20,60,0.25)" }}>
              <Lock size={15} style={{ color: "#DC143C" }} />
            </div>
            <div>
              <div className="text-xs font-bold tracking-[0.15em] uppercase" style={{ color: "#C0C0C0" }}>Confidentiality Agreement</div>
              <div className="text-[10px] font-mono mt-0.5" style={{ color: "#555" }}>Required before accessing the Platform</div>
            </div>
          </div>
        </div>

        {/* Scrollable body */}
        <div
          ref={scrollRef}
          className="overflow-y-auto px-6 py-5 text-sm space-y-4"
          style={{ maxHeight: "38vh", color: "#888" }}
        >
          <p>
            Welcome, <span className="font-semibold" style={{ color: "#C0C0C0" }}>{userEmail}</span>. Before you enter the Platform, you must acknowledge and agree to the following obligations.
          </p>

          <div className="rounded-xl border p-4 space-y-2" style={{ borderColor: "rgba(220,20,60,0.2)", background: "rgba(220,20,60,0.04)" }}>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide mb-1" style={{ color: "#DC143C" }}>
              <ShieldCheck size={13} />
              Non-Disclosure Obligations
            </div>
            <p>All Platform content — including pricing, product listings, order data, and operational workflows — is strictly confidential and proprietary.</p>
            <p>You agree <strong style={{ color: "#ccc" }}>NOT to</strong> take screenshots, screen recordings, or photographs of any part of this Platform, and <strong style={{ color: "#ccc" }}>NOT to</strong> share, forward, or disclose any content to unauthorized parties.</p>
          </div>

          <div className="rounded-xl border p-4 space-y-2" style={{ borderColor: "rgba(255,107,0,0.2)", background: "rgba(255,107,0,0.03)" }}>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide mb-1" style={{ color: "#FF6B00" }}>
              <AlertTriangle size={13} />
              Liquidated Damages Clause
            </div>
            <p>You acknowledge that unauthorized disclosure, screenshot, or recording of Platform content constitutes a material breach of these Terms, and you agree to pay liquidated damages of <strong style={{ color: "#FF6B00" }}>$5,000 USD per incident</strong>.</p>
          </div>

          <div className="rounded-xl border p-4 space-y-2" style={{ borderColor: "rgba(192,192,192,0.1)", background: "rgba(192,192,192,0.02)" }}>
            <div className="text-xs font-bold uppercase tracking-wide mb-1" style={{ color: "#888" }}>Session Monitoring</div>
            <p>Your session is logged. Your email address is embedded as a watermark on all Platform pages. Any screenshot will contain your identifying information.</p>
          </div>

          <p className="text-xs" style={{ color: "#555" }}>
            By proceeding you confirm you are 18+ and agree to the full{" "}
            <Link href="/terms-of-service" target="_blank" className="underline inline-flex items-center gap-1" style={{ color: "#DC143C" }}>
              Terms &amp; Conditions <ExternalLink size={10} />
            </Link>{" "}
            including the NDA and Liquidated Damages provisions.
          </p>

          {/* Scroll prompt */}
          {!scrolledToBottom && (
            <div className="text-center text-[10px] font-mono pt-2 animate-pulse" style={{ color: "#444" }}>
              ↓ Scroll to read all terms
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-6 py-5 border-t space-y-4" style={{ borderColor: "rgba(220,20,60,0.1)", background: "#0A0000" }}>
          <label className="flex items-start gap-3 cursor-pointer">
            <div
              className="w-5 h-5 rounded flex items-center justify-center border transition-all flex-shrink-0 mt-0.5"
              style={{
                borderColor: checked ? "#DC143C" : "rgba(220,20,60,0.3)",
                background: checked ? "rgba(220,20,60,0.2)" : "transparent",
              }}
            >
              {checked && (
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path d="M1 4L3.5 6.5L9 1" stroke="#DC143C" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
            <input type="checkbox" className="sr-only" checked={checked} onChange={e => setChecked(e.target.checked)} />
            <span className="text-xs leading-relaxed" style={{ color: checked ? "#aaa" : "#666" }}>
              I have read and agree to the Terms &amp; Conditions, including the Non-Disclosure Agreement and Liquidated Damages clause. I understand my session is monitored and watermarked.
            </span>
          </label>

          <button
            onClick={handleAccept}
            disabled={!checked}
            className="w-full py-3 rounded-xl text-sm font-bold tracking-[0.1em] uppercase transition-all"
            style={{
              background: checked ? "linear-gradient(135deg, #DC143C, #8B0000)" : "rgba(100,0,0,0.2)",
              color: checked ? "#fff" : "#444",
              boxShadow: checked ? "0 8px 32px rgba(220,20,60,0.35)" : "none",
              cursor: checked ? "pointer" : "not-allowed",
            }}
          >
            <Lock size={13} className="inline mr-2" />
            Accept &amp; Enter Platform
          </button>
        </div>
      </div>
    </div>
  );
}
