import { useClerk } from "@clerk/react";
import { Button } from "@/components/ui/button";

interface PendingPageProps {
  status?: "pending" | "rejected";
}

export default function PendingPage({ status = "pending" }: PendingPageProps) {
  const { signOut } = useClerk();
  const isRejected = status === "rejected";

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden"
      style={{ background: "#0A0000" }}
    >
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(180,0,0,0.015) 4px)",
        }}
      />
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E\")",
          backgroundRepeat: "repeat",
          backgroundSize: "128px",
        }}
      />
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(220,20,60,0.08) 0%, transparent 70%)",
          filter: "blur(60px)",
        }}
      />

      <div className="relative z-10 flex flex-col items-center gap-6 w-full max-w-md px-6 text-center">
        <img
          src="/lc-icon.png"
          alt="Lucifer Cruz"
          className="w-14 h-14 object-contain"
          style={{ filter: "invert(1) brightness(1.2)" }}
        />

        <div>
          <div
            className="font-bold tracking-[0.2em] text-base mb-1"
            style={{ color: "#C0C0C0" }}
          >
            LUCIFER CRUZ
          </div>
          <div
            className="text-[10px] font-mono tracking-[0.35em] uppercase"
            style={{ color: "#8B0000" }}
          >
            Adult Boutique · 18+
          </div>
        </div>

        <div
          className="w-full rounded-lg border p-6 flex flex-col gap-4"
          style={{
            background: "rgba(20,5,5,0.9)",
            borderColor: isRejected ? "rgba(100,0,0,0.5)" : "rgba(139,0,0,0.3)",
          }}
        >
          <div
            className="flex items-center justify-center w-12 h-12 rounded-full mx-auto"
            style={{
              background: isRejected ? "rgba(100,0,0,0.2)" : "rgba(139,0,0,0.15)",
              border: isRejected ? "1px solid rgba(100,0,0,0.5)" : "1px solid rgba(139,0,0,0.3)",
            }}
          >
            {isRejected ? (
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ color: "#8B0000" }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            ) : (
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ color: "#8B0000" }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            )}
          </div>

          <div>
            <h1
              className="text-lg font-semibold tracking-wide mb-2"
              style={{ color: "#C0C0C0" }}
            >
              {isRejected ? "Your account was not approved" : "Your account is awaiting approval"}
            </h1>
            <p
              className="text-sm leading-relaxed"
              style={{ color: "#666" }}
            >
              {isRejected
                ? "Your account application was not approved. If you believe this is an error, please contact us for assistance."
                : "Your account has been created and is currently awaiting approval from an administrator. You will be notified once your access is granted."}
            </p>
          </div>

          <div
            className="text-xs font-mono p-3 rounded"
            style={{
              background: isRejected ? "rgba(100,0,0,0.1)" : "rgba(139,0,0,0.08)",
              border: isRejected ? "1px solid rgba(100,0,0,0.2)" : "1px solid rgba(139,0,0,0.15)",
              color: "#555",
            }}
          >
            {isRejected ? "STATUS: ACCESS DENIED" : "STATUS: PENDING REVIEW"}
          </div>
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="text-xs font-mono tracking-widest uppercase"
          style={{ color: "#444" }}
          onClick={() => signOut({ redirectUrl: "/" })}
        >
          Sign Out
        </Button>

        <p className="text-[10px] font-mono" style={{ color: "#222" }}>
          ADULTS ONLY · 18+ · DISCREET · SECURE
        </p>
      </div>
    </div>
  );
}
