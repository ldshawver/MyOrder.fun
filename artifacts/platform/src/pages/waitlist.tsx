import { Waitlist } from "@clerk/react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function WaitlistPage() {
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
      <div className="relative z-10 flex flex-col items-center gap-6 w-full px-4">
        <div className="flex flex-col items-center gap-3 mb-2">
          <img
            src={`${basePath}/lc-icon.png`}
            alt="Lucifer Cruz"
            className="w-12 h-12 object-contain"
            style={{ filter: "invert(1) brightness(1.2)" }}
          />
          <div className="text-center">
            <div
              className="font-bold tracking-[0.2em] text-base"
              style={{ color: "#C0C0C0" }}
            >
              LUCIFER CRUZ
            </div>
            <div
              className="text-[10px] font-mono tracking-[0.35em] uppercase mt-0.5"
              style={{ color: "#8B0000" }}
            >
              Adult Boutique · 18+
            </div>
          </div>
        </div>
        <Waitlist signInUrl={`${basePath}/sign-in`} />
        <p
          className="text-[10px] font-mono mt-2"
          style={{ color: "#333" }}
        >
          ADULTS ONLY · 18+ · DISCREET · SECURE
        </p>
      </div>
    </div>
  );
}
