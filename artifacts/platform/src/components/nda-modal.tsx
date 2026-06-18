import { useEffect, useRef, useState } from "react";
import { ShieldCheck, AlertTriangle, Lock } from "lucide-react";

interface NdaModalProps {
  userEmail: string;
  text: string;
  version: number;
  accepting?: boolean;
  error?: string | null;
  onAccept: () => void;
}

export default function NdaModal({ userEmail, text, version, accepting = false, error, onAccept }: NdaModalProps) {
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
    handleScroll();
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [text]);

  function handleAccept() {
    if (!checked || accepting) return;
    onAccept();
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.92)", backdropFilter: "blur(8px)" }}>
      <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(180,0,0,0.012) 4px)" }} />

      <div className="relative w-full max-w-lg rounded-2xl border overflow-hidden shadow-2xl" style={{ borderColor: "rgba(220,20,60,0.25)", background: "#0D0000" }}>
        <div className="px-6 pt-6 pb-4 border-b" style={{ borderColor: "rgba(220,20,60,0.12)" }}>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "rgba(220,20,60,0.12)", border: "1px solid rgba(220,20,60,0.25)" }}>
              <Lock size={15} style={{ color: "#DC143C" }} />
            </div>
            <div>
              <div className="text-xs font-bold tracking-[0.15em] uppercase" style={{ color: "#C0C0C0" }}>Customer Disclaimer</div>
              <div className="text-[10px] font-mono mt-0.5" style={{ color: "#555" }}>Version {version} · required before accessing MyOrder.fun</div>
            </div>
          </div>
        </div>

        <div ref={scrollRef} className="overflow-y-auto px-6 py-5 text-sm space-y-4" style={{ maxHeight: "38vh", color: "#888" }}>
          <p>
            Welcome, <span className="font-semibold" style={{ color: "#C0C0C0" }}>{userEmail}</span>. Please review and accept the current customer disclaimer.
          </p>

          <div className="rounded-xl border p-4 space-y-2 whitespace-pre-wrap" style={{ borderColor: "rgba(220,20,60,0.2)", background: "rgba(220,20,60,0.04)" }}>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide mb-1" style={{ color: "#DC143C" }}>
              <ShieldCheck size={13} />
              Current disclaimer
            </div>
            <p>{text}</p>
          </div>

          <div className="rounded-xl border p-4 space-y-2" style={{ borderColor: "rgba(255,107,0,0.2)", background: "rgba(255,107,0,0.03)" }}>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide mb-1" style={{ color: "#FF6B00" }}>
              <AlertTriangle size={13} />
              Acceptance is account-bound
            </div>
            <p>This acceptance is recorded for your signed-in user and tenant only. Do not accept on behalf of another person.</p>
          </div>

          {error && <p className="text-xs" style={{ color: "#FF6B00" }}>{error}</p>}

          {!scrolledToBottom && (
            <div className="text-center text-[10px] font-mono pt-2 animate-pulse" style={{ color: "#444" }}>
              ↓ Scroll to read all terms
            </div>
          )}
        </div>

        <div className="px-6 py-5 border-t space-y-4" style={{ borderColor: "rgba(220,20,60,0.1)", background: "#0A0000" }}>
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" className="mt-1" checked={checked} onChange={e => setChecked(e.target.checked)} />
            <span className="text-xs leading-relaxed" style={{ color: checked ? "#aaa" : "#666" }}>
              I have read and agree to customer disclaimer version {version}.
            </span>
          </label>

          <button onClick={handleAccept} disabled={!checked || accepting} className="w-full py-3 rounded-xl text-sm font-bold tracking-[0.1em] uppercase transition-all" style={{ background: checked && !accepting ? "linear-gradient(135deg, #DC143C, #8B0000)" : "rgba(100,0,0,0.2)", color: checked && !accepting ? "#fff" : "#444", cursor: checked && !accepting ? "pointer" : "not-allowed" }}>
            <Lock size={13} className="inline mr-2" />
            {accepting ? "Recording acceptance…" : "Accept & Enter Platform"}
          </button>
        </div>
      </div>
    </div>
  );
}
