import { useAuth } from "@clerk/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "@/hooks/use-toast";

type PrivacyEvent = "sensitive_screen_viewed" | "sensitive_screen_hidden_on_blur" | "print_attempt" | "screenshot_key_attempt" | "context_menu_blocked";

export type SensitiveScreenProps = {
  children: ReactNode;
  userEmail?: string | null;
  userRole?: string | null;
  tenantName?: string | null;
  route?: string;
  privacyModeEnabled?: boolean;
  sensitiveScreensProtectionEnabled?: boolean;
  watermarkSensitiveScreens?: boolean;
  blurOnBackground?: boolean;
  printBlockingEnabled?: boolean;
};

function maskEmail(email?: string | null): string {
  if (!email) return "unknown user";
  const [localPart = "", domain = ""] = email.split("@");
  if (!domain) return "user";
  const first = localPart[0] ?? "u";
  return `${first}${"•".repeat(Math.min(Math.max(localPart.length - 1, 2), 6))}@${domain}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}

export default function SensitiveScreen({ children, userEmail, userRole, tenantName, route, privacyModeEnabled = true, sensitiveScreensProtectionEnabled = true, watermarkSensitiveScreens = true, blurOnBackground = true, printBlockingEnabled = true }: SensitiveScreenProps) {
  const { getToken } = useAuth();
  const [covered, setCovered] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const active = privacyModeEnabled && sensitiveScreensProtectionEnabled;
  const watermark = useMemo(() => [maskEmail(userEmail), userRole || "unknown role", tenantName || "MyOrder.fun", now.toISOString()].join(" • "), [userEmail, userRole, tenantName, now]);

  const logEvent = useCallback(async (eventType: PrivacyEvent) => {
    try {
      const token = await getToken();
      if (!token) return;
      await fetch("/api/privacy/events", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ eventType, route: route ?? window.location.pathname }) });
    } catch { /* best-effort */ }
  }, [getToken, route]);
  const warn = useCallback(() => toast({ title: "Privacy restricted", description: "Screenshots/printing are restricted on this screen. Activity may be logged." }), []);

  useEffect(() => {
    if (!active) return;
    void logEvent("sensitive_screen_viewed");
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [active, logEvent]);

  useEffect(() => {
    if (!active || !blurOnBackground) return;
    const hide = () => {
      if (document.hidden || !document.hasFocus()) {
        setCovered(true);
        void logEvent("sensitive_screen_hidden_on_blur");
      }
    };
    const show = () => { if (!document.hidden) setCovered(false); };
    const onVisibility = () => (document.hidden ? hide() : show());
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", hide);
    window.addEventListener("focus", show);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", hide);
      window.removeEventListener("focus", show);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, [active, blurOnBackground, logEvent]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === "printscreen") { warn(); void logEvent("screenshot_key_attempt"); }
      if (printBlockingEnabled && key === "p" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); warn(); void logEvent("print_attempt"); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, printBlockingEnabled, logEvent, warn]);

  const onContextMenu = (event: React.MouseEvent) => {
    if (!active || isEditableTarget(event.target)) return;
    event.preventDefault(); warn(); void logEvent("context_menu_blocked");
  };

  return (
    <section className="sensitive-screen relative min-h-0" onContextMenu={onContextMenu} data-testid="sensitive-screen">
      <div className="sensitive-print-warning hidden rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">Sensitive content hidden from print/export.</div>
      <div className={active ? "sensitive-screen-content" : undefined}>{children}</div>
      {active && watermarkSensitiveScreens && <div className="sensitive-watermark pointer-events-none absolute inset-0 z-40 overflow-hidden opacity-[0.16]" aria-hidden="true"><div className="absolute inset-0 grid place-items-center text-[11px] font-mono uppercase tracking-widest text-white/70" style={{ transform: "rotate(-24deg)", gridTemplateColumns: "repeat(3, minmax(260px, 1fr))", gap: "4rem" }}>{Array.from({ length: 18 }).map((_, i) => <span key={i}>{watermark}</span>)}</div></div>}
      {active && covered && <div className="absolute inset-0 z-50 grid place-items-center rounded-2xl bg-background/95 backdrop-blur-xl" data-testid="sensitive-cover"><div className="text-center"><div className="text-sm font-semibold">Sensitive screen protected</div><div className="mt-1 text-xs text-muted-foreground">Content hidden while the app is not active.</div></div></div>}
    </section>
  );
}
