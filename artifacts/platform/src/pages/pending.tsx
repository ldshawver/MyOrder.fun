import { useState } from "react";
import { useClerk } from "@clerk/react";
import { useAuth } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { useBrand } from "@/contexts/BrandContext";

interface PendingPageProps {
  status?: "pending" | "rejected";
  userEmail?: string;
  onCheckStatus?: () => Promise<void>;
}

export default function PendingPage({ status = "pending", userEmail, onCheckStatus }: PendingPageProps) {
  const { signOut } = useClerk();
  const { getToken } = useAuth();
  const { branding } = useBrand();
  const isRejected = status === "rejected";
  const [isChecking, setIsChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<"still_pending" | "error" | null>(null);
  const [recoveryRequest, setRecoveryRequest] = useState(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem("myorder.pending-access-request") ?? "null") as { name?: string; email?: string; phone?: string; message?: string } | null;
      return value?.name && value.email ? value : null;
    } catch { return null; }
  });
  const [recoveryFile, setRecoveryFile] = useState<File | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");

  async function resumeRegistration() {
    if (!recoveryRequest || recoveryBusy) return;
    setRecoveryBusy(true);
    setRecoveryMessage("");
    try {
      const token = await getToken();
      if (!token) throw new Error("Your sign-in session expired. Sign in again to finish setup.");
      let imageId: string | null = null;
      const me = await fetch(`${import.meta.env.BASE_URL}api/users/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (me.ok) {
        const user = await me.json() as { avatarUrl?: string };
        imageId = user.avatarUrl?.match(/^\/api\/profile-images\/([0-9a-f-]{36})$/i)?.[1] ?? null;
      }
      if (!imageId) {
        if (!recoveryFile) throw new Error("Choose your profile picture again to finish registration.");
        const form = new FormData();
        form.set("email", recoveryRequest.email!);
        form.set("file", recoveryFile);
        const uploaded = await fetch(`${import.meta.env.BASE_URL}api/profile-images`, { method: "POST", body: form });
        const result = await uploaded.json().catch(() => ({}));
        if (!uploaded.ok || typeof result.uploadId !== "string") throw new Error(result.error ?? "Profile picture upload failed.");
        imageId = result.uploadId;
      }
      const response = await fetch(`${import.meta.env.BASE_URL}api/onboarding/request`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: "Individual", contactName: recoveryRequest.name, contactEmail: recoveryRequest.email,
          contactPhone: recoveryRequest.phone || undefined, description: recoveryRequest.message || undefined,
          businessType: "customer", profileImageUploadId: imageId,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Registration setup could not be completed.");
      sessionStorage.removeItem("myorder.pending-access-request");
      setRecoveryRequest(null);
      setRecoveryMessage("Registration setup is complete. Your account remains pending approval.");
    } catch (err) {
      setRecoveryMessage(err instanceof Error ? err.message : "Registration setup could not be completed.");
    } finally { setRecoveryBusy(false); }
  }

  async function handleCheckStatus() {
    if (!onCheckStatus || isChecking) return;
    setIsChecking(true);
    setCheckResult(null);
    try {
      await onCheckStatus();
      setCheckResult("still_pending");
    } catch {
      setCheckResult("error");
    } finally {
      setIsChecking(false);
    }
  }

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
          src={branding.customer.logoUrl}
          alt={branding.customer.displayName}
          className="h-20 w-auto object-contain"
        />

        <div>
          <div
            className="font-bold tracking-[0.2em] text-base mb-1"
            style={{ color: "#C0C0C0" }}
          >
            {branding.customer.displayName}
          </div>
          <div
            className="text-[10px] font-mono tracking-[0.35em] uppercase"
            style={{ color: "#8B0000" }}
          >
            Private storefront
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

          {userEmail && (
            <div
              className="text-xs p-3 rounded flex flex-col gap-1"
              style={{
                background: "rgba(139,0,0,0.05)",
                border: "1px solid rgba(139,0,0,0.12)",
              }}
            >
              <span className="font-mono tracking-wider uppercase" style={{ color: "#444", fontSize: "9px" }}>Registered account</span>
              <span style={{ color: "#777" }}>{userEmail}</span>
            </div>
          )}

          {!isRejected && onCheckStatus && (
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full text-xs font-mono tracking-widest uppercase"
                style={{
                  borderColor: "rgba(139,0,0,0.3)",
                  color: "#888",
                  background: "rgba(139,0,0,0.05)",
                }}
                onClick={handleCheckStatus}
                disabled={isChecking}
              >
                {isChecking ? "Checking..." : "Check my status"}
              </Button>
              {checkResult === "still_pending" && (
                <p
                  className="text-[11px] font-mono text-center"
                  style={{ color: "#555" }}
                >
                  Checked — still under review
                </p>
              )}
              {checkResult === "error" && (
                <p
                  className="text-[11px] font-mono text-center"
                  style={{ color: "#8B0000" }}
                >
                  Unable to check — please try again
                </p>
              )}
            </div>
          )}
          {!isRejected && recoveryRequest && (
            <div className="flex flex-col gap-3 border-t border-red-950/40 pt-4 text-left">
              <p className="text-xs leading-relaxed text-muted-foreground">Finish the access request interrupted during registration. If your profile picture was not saved, choose it again.</p>
              <label className="text-xs text-muted-foreground" htmlFor="recovery-profile-image">Profile picture if requested</label>
              <input id="recovery-profile-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setRecoveryFile(event.target.files?.[0] ?? null)} className="text-xs text-muted-foreground file:mr-2 file:rounded file:border-0 file:bg-[#8b0000] file:px-2 file:py-1 file:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#dc143c]" />
              <Button type="button" size="sm" onClick={() => void resumeRegistration()} disabled={recoveryBusy} className="bg-[#8b0000] text-white hover:bg-[#a00020] focus-visible:ring-[#dc143c]">{recoveryBusy ? "Finishing…" : "Finish registration setup"}</Button>
              {recoveryMessage && <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{recoveryMessage}</p>}
            </div>
          )}
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
