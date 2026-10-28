import { useRef, useState } from "react";
import { useSignUp } from "@clerk/react/legacy";
import { useAuth } from "@clerk/react";
import { Link } from "wouter";
import { useBrand } from "@/contexts/BrandContext";
import { clerkRegistrationErrorKind, registrationAction } from "@/lib/registrationFlow";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const BASE_API = import.meta.env.BASE_URL.replace(/\/$/, "");

type WaitlistForm = {
  name: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  message: string;
};

type ClerkSignUpLike = {
  status?: string | null;
  createdSessionId?: string | null;
  missingFields?: string[];
};

function isCaptchaError(err: unknown): boolean {
  const errors = (err as { errors?: Array<{ code?: string; message?: string }> })?.errors;
  const code = errors?.[0]?.code ?? "";
  const msg = (errors?.[0]?.message ?? "").toLowerCase();
  return (
    code.toLowerCase().includes("captcha") ||
    msg.includes("captcha") ||
    msg.includes("bot protection") ||
    msg.includes("turnstile")
  );
}

function getClerkErrorMessage(err: unknown): string {
  if (isCaptchaError(err)) {
    return "CAPTCHA_ERROR";
  }
  const errors = (err as { errors?: Array<{ longMessage?: string; message?: string }> })?.errors;
  const errorKind = clerkRegistrationErrorKind(err);
  if (errorKind === "expired_code") return "That email code has expired. Request a new code below and try again.";
  if (errorKind === "already_verified") return "Your email is already verified. Refresh verification and retry access setup; you do not need another code.";
  if (errorKind === "duplicate_identity") return "This address cannot be registered here. Try signing in or contact support for help.";
  const clerkMessage = errors?.[0]?.longMessage ?? errors?.[0]?.message;
  if (clerkMessage) return clerkMessage;
  return err instanceof Error ? err.message : "Something went wrong";
}

function splitName(fullName: string): { firstName: string; lastName?: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const [firstName = "", ...rest] = parts;
  return {
    firstName,
    lastName: rest.length > 0 ? rest.join(" ") : undefined,
  };
}

function readPendingRequest(): WaitlistForm | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem("myorder.pending-access-request") ?? "null") as Partial<WaitlistForm> | null;
    if (!saved?.name || !saved.email) return null;
    return { name: saved.name, email: saved.email, phone: saved.phone ?? "", message: saved.message ?? "", password: "", confirmPassword: "" };
  } catch { return null; }
}

export default function WaitlistPage() {
  const { branding, publicBrandLoading } = useBrand();
  const { isLoaded, signUp, setActive } = useSignUp();
  const { getToken } = useAuth();
  const [form, setForm] = useState<WaitlistForm>(() => readPendingRequest() ?? {
    name: "", email: "", phone: "", password: "", confirmPassword: "", message: "",
  });
  const [verificationCode, setVerificationCode] = useState("");
  const [awaitingVerification, setAwaitingVerification] = useState(() => !!readPendingRequest());
  const [submittedForm, setSubmittedForm] = useState<WaitlistForm | null>(() => readPendingRequest());
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [profileImageFile, setProfileImageFile] = useState<File | null>(null);
  const [profileImageUploadId, setProfileImageUploadId] = useState<string | null>(null);
  const [profileImageEmail, setProfileImageEmail] = useState("");
  const [imageStatus, setImageStatus] = useState<"idle" | "uploading" | "ready" | "error">("idle");
  const submitting = useRef(false);

  async function ensureProfileImage(email: string): Promise<string> {
    if (profileImageUploadId && profileImageEmail.toLowerCase() === email.trim().toLowerCase()) return profileImageUploadId;
    if (!profileImageFile) throw new Error("Choose and upload a profile picture before continuing.");
    const upload = new FormData();
    upload.set("file", profileImageFile);
    upload.set("email", email.trim());
    setImageStatus("uploading");
    const response = await fetch(`${BASE_API}/api/profile-images`, { method: "POST", body: upload });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setImageStatus("error");
      throw new Error(body.error ?? "Profile picture upload failed. Choose the image again and retry.");
    }
    const body = await response.json() as { uploadId: string };
    setProfileImageUploadId(body.uploadId);
    setProfileImageEmail(email.trim());
    setImageStatus("ready");
    return body.uploadId;
  }

  async function submitAccessRequest(values: WaitlistForm, imageId: string) {
    const token = await getToken();
    const res = await fetch(`${BASE_API}/api/onboarding/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        contactName: values.name,
        contactEmail: values.email,
        contactPhone: values.phone || undefined,
        description: values.message || undefined,
        companyName: "Individual",
        businessType: "customer",
        profileImageUploadId: imageId,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Request failed");
    }
  }

  async function finishClerkSignUp(result: ClerkSignUpLike, values: WaitlistForm, imageId: string) {
    if (result.status === "complete") {
      // Persist only non-secret request details. Clerk keeps the verified sign-up
      // resource; on refresh/retry we resume provisioning instead of consuming
      // the email code a second time. Never persist the password or code.
      sessionStorage.setItem("myorder.pending-access-request", JSON.stringify({
        name: values.name, email: values.email, phone: values.phone, message: values.message,
      }));
      setSubmittedForm(values);
      setAwaitingVerification(true);
      setVerificationCode("");
      setStatus("loading");
      if (result.createdSessionId && setActive) {
        await setActive({ session: result.createdSessionId });
      }
      await submitAccessRequest(values, imageId);
      sessionStorage.removeItem("myorder.pending-access-request");
      setAwaitingVerification(false);
      setStatus("success");
      return;
    }

    if (result.status === "missing_requirements" || result.missingFields?.includes("email_address_verification")) {
      await signUp?.prepareEmailAddressVerification({ strategy: "email_code" });
      sessionStorage.setItem("myorder.pending-access-request", JSON.stringify({ name: values.name, email: values.email, phone: values.phone, message: values.message }));
      setSubmittedForm(values);
      setAwaitingVerification(true);
      setStatus("idle");
      return;
    }

    throw new Error("Sign up needs additional verification. Please use the Clerk sign up link below.");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signUp || submitting.current) return;
    setStatus("loading");
    setErrorMsg("");

    const alreadyVerified = registrationAction(signUp.status) === "resume_provisioning";
    const requestValues = alreadyVerified ? (submittedForm ?? readPendingRequest() ?? form) : form;
    const password = form.password.trim();
    if (!alreadyVerified && password.length < 8) {
      setErrorMsg("Password must be at least 8 characters.");
      setStatus("error");
      return;
    }
    if (!alreadyVerified && password !== form.confirmPassword.trim()) {
      setErrorMsg("Passwords do not match.");
      setStatus("error");
      return;
    }

    submitting.current = true;
    try {
      const imageId = await ensureProfileImage(requestValues.email);
      const { firstName, lastName } = splitName(requestValues.name);
      const result = alreadyVerified
        ? signUp as ClerkSignUpLike
        : await signUp.create({
        emailAddress: requestValues.email.trim(),
        ...(!alreadyVerified ? { password } : {}),
        firstName,
        lastName,
        unsafeMetadata: {
          contactPhone: requestValues.phone.trim() || undefined,
          accessRequest: true,
        },
      });
      await finishClerkSignUp(result, requestValues, imageId);
    } catch (err) {
      setErrorMsg(signUp.status === "complete"
        ? "Your email is verified, but access setup did not finish. Select ‘Retry access setup’; you do not need another code."
        : getClerkErrorMessage(err));
      setStatus("error");
    } finally {
      submitting.current = false;
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signUp || submitting.current) return;
    const values = submittedForm ?? readPendingRequest();
    if (!values) {
      setErrorMsg("Your verified sign-up is ready. Return to the registration page and enter your name and email to finish access setup.");
      setStatus("error");
      return;
    }
    submitting.current = true;
    setStatus("loading");
    setErrorMsg("");

    try {
      const imageId = await ensureProfileImage(values.email);
      // Clerk may have already completed verification before a network failure
      // or refresh. In that state, retry only our idempotent provisioning call.
      const result = registrationAction(signUp.status) === "resume_provisioning"
        ? signUp as ClerkSignUpLike
        : await signUp.attemptEmailAddressVerification({ code: verificationCode.trim() });
      await finishClerkSignUp(result, values, imageId);
    } catch (err) {
      if (clerkRegistrationErrorKind(err) === "already_verified") {
        try {
          const refreshed = await signUp.reload();
          if (refreshed.status === "complete") {
            const imageId = await ensureProfileImage(values.email);
            await finishClerkSignUp(refreshed, values, imageId);
            return;
          }
        } catch { /* display a safe retry message below */ }
        setErrorMsg("Your email is already verified. Refresh the page, choose your profile picture again, and retry access setup.");
        setStatus("error");
        return;
      }
      setErrorMsg(signUp.status === "complete"
        ? "Your email is verified, but access setup did not finish. Select ‘Retry access setup’; you do not need another code."
        : getClerkErrorMessage(err));
      setStatus("error");
    } finally {
      submitting.current = false;
    }
  }

  async function resendVerificationCode() {
    if (!signUp || signUp.status === "complete") return;
    setStatus("loading");
    setErrorMsg("");
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setStatus("idle");
    } catch (err) {
      setErrorMsg(getClerkErrorMessage(err));
      setStatus("error");
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
          background: "radial-gradient(circle, rgba(220,20,60,0.08) 0%, transparent 70%)",
          filter: "blur(60px)",
        }}
      />

      <div className="relative z-10 flex flex-col items-center gap-6 w-full px-4 max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-2">
          <img
            src={branding.customer.logoUrl}
            alt={branding.customer.displayName}
            className="h-20 w-auto object-contain"
          />
          <div className="text-center">
            <div className="font-bold tracking-[0.2em] text-base" style={{ color: "#C0C0C0" }}>
              {publicBrandLoading ? "Loading storefront…" : branding.customer.displayName}
            </div>
            <div className="text-[10px] font-mono tracking-[0.35em] uppercase mt-0.5" style={{ color: "#8B0000" }}>
              Private storefront
            </div>
          </div>
        </div>

        {status === "success" ? (
          <div
            className="w-full rounded-xl p-6 text-center flex flex-col gap-4"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(220,20,60,0.2)" }}
          >
            <div className="text-2xl">✓</div>
            <p className="text-sm font-mono" style={{ color: "#C0C0C0" }}>
              Account created.
            </p>
            <p className="text-xs font-mono" style={{ color: "#555" }}>
              Your access request is waiting for approval.
            </p>
            <Link
              href={`${basePath}/sign-in`}
              className="text-xs font-mono underline mt-2"
              style={{ color: "#8B0000" }}
            >
              Already approved? Sign in
            </Link>
          </div>
        ) : awaitingVerification ? (
          <form
            onSubmit={handleVerify}
            className="w-full flex flex-col gap-3"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(220,20,60,0.15)",
              borderRadius: "0.75rem",
              padding: "1.5rem",
            }}
          >
            <p className="text-xs font-mono tracking-widest uppercase mb-1" style={{ color: "#555" }}>
              Verify Email
            </p>

            <label className="text-xs font-mono" style={{ color: "#c0c0c0" }} htmlFor="verify-profile-picture">
              Profile picture (required)
            </label>
            <input id="verify-profile-picture" type="file" accept="image/png,image/jpeg,image/webp" required={!profileImageUploadId} onChange={(e) => {
              setProfileImageFile(e.target.files?.[0] ?? null);
              setProfileImageUploadId(null);
              setProfileImageEmail("");
              setImageStatus("idle");
            }} aria-describedby="verify-profile-picture-help" className="w-full text-xs font-mono text-[#c0c0c0] file:mr-3 file:rounded file:border-0 file:bg-[#8b0000] file:px-3 file:py-2 file:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#dc143c]" />
            <p id="verify-profile-picture-help" className="text-[11px] font-mono" style={{ color: imageStatus === "error" ? "#dc143c" : "#999" }}>
              {imageStatus === "ready" ? "Image uploaded securely." : imageStatus === "uploading" ? "Validating image…" : "PNG, JPEG, or WebP, up to 3 MB. Choose again after a page refresh."}
            </p>

            {signUp?.status !== "complete" && <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Verification code"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#C0C0C0",
              }}
            />}

            {status === "error" && (
              <p className="text-xs font-mono" style={{ color: "#DC143C" }}>
                {errorMsg}
              </p>
            )}
            {status === "error" && signUp?.status !== "complete" && (
              <button type="button" onClick={() => void resendVerificationCode()} className="self-start text-xs font-mono underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#dc143c]" style={{ color: "#ff526b" }}>
                Send a new verification code
              </button>
            )}

            <button
              type="submit"
              disabled={status === "loading"}
              className="w-full rounded-lg py-2 text-sm font-mono tracking-widest uppercase transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={{
                background: "#8B0000",
                color: "#C0C0C0",
                opacity: status === "loading" ? 0.6 : 1,
              }}
            >
              {status === "loading" ? "Finishing…" : signUp?.status === "complete" ? "Retry access setup" : "Verify & Request Access"}
            </button>
          </form>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="w-full flex flex-col gap-3"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(220,20,60,0.15)",
              borderRadius: "0.75rem",
              padding: "1.5rem",
            }}
          >
            <p className="text-xs font-mono tracking-widest uppercase mb-1" style={{ color: "#555" }}>
              Request Access
            </p>

            <label className="text-xs font-mono" style={{ color: "#c0c0c0" }} htmlFor="signup-profile-picture">
              Profile picture (required)
            </label>
            <input id="signup-profile-picture" type="file" accept="image/png,image/jpeg,image/webp" required={!profileImageUploadId} onChange={(e) => {
              setProfileImageFile(e.target.files?.[0] ?? null);
              setProfileImageUploadId(null);
              setProfileImageEmail("");
              setImageStatus("idle");
            }} aria-describedby="signup-profile-picture-help" className="w-full text-xs font-mono text-[#c0c0c0] file:mr-3 file:rounded file:border-0 file:bg-[#8b0000] file:px-3 file:py-2 file:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#dc143c]" />
            <p id="signup-profile-picture-help" className="text-[11px] font-mono" style={{ color: imageStatus === "error" ? "#dc143c" : "#999" }}>
              {imageStatus === "ready" ? "Image uploaded securely." : imageStatus === "uploading" ? "Validating image…" : "PNG, JPEG, or WebP, up to 3 MB."}
            </p>

            {signUp?.status !== "complete" && <input
              required
              type="text"
              placeholder="Full name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#C0C0C0",
              }}
            />}

            <input
              required={signUp?.status !== "complete"}
              type="email"
              placeholder="Email address"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#C0C0C0",
              }}
            />

            <input
              type="tel"
              placeholder="Phone"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#C0C0C0",
              }}
            />

            <input
              required={signUp?.status !== "complete"}
              type="password"
              autoComplete="new-password"
              placeholder="Password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#C0C0C0",
              }}
            />

            <input
              required
              type="password"
              autoComplete="new-password"
              placeholder="Confirm password"
              value={form.confirmPassword}
              onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#C0C0C0",
              }}
            />

            <textarea
              placeholder="Message (optional)"
              value={form.message}
              onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
              rows={3}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c] resize-none"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#C0C0C0",
              }}
            />

            {status === "error" && errorMsg === "CAPTCHA_ERROR" && (
              <div
                className="w-full rounded-lg p-3 text-xs font-mono flex flex-col gap-2"
                style={{ background: "rgba(139,0,0,0.15)", border: "1px solid rgba(220,20,60,0.3)", color: "#C0C0C0" }}
              >
                <p style={{ color: "#DC143C" }}>⚠ Security check couldn't load</p>
                <p style={{ color: "#888" }}>Your browser blocked the sign-up security check. Use the link below to register instead.</p>
                <Link href={`${basePath}/sign-up`} className="underline font-bold" style={{ color: "#DC143C" }}>
                  → Sign up via secure portal
                </Link>
              </div>
            )}
            {status === "error" && errorMsg !== "CAPTCHA_ERROR" && (
              <p className="text-xs font-mono" style={{ color: "#DC143C" }}>
                {errorMsg}
              </p>
            )}

            <button
              type="submit"
              disabled={status === "loading"}
              className="w-full rounded-lg py-2 text-sm font-mono tracking-widest uppercase transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={{
                background: "#8B0000",
                color: "#C0C0C0",
                opacity: status === "loading" ? 0.6 : 1,
              }}
            >
              {status === "loading" ? "Sending…" : "Request Access"}
            </button>

            <Link
              href={`${basePath}/sign-in`}
              className="text-center text-xs font-mono mt-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={{ color: "#444" }}
            >
              Already have access?{" "}
              <span style={{ color: "#8B0000", textDecoration: "underline" }}>Sign in</span>
            </Link>
          </form>
        )}

        <p className="text-[10px] font-mono" style={{ color: "#333" }}>
          ADULTS ONLY · 18+ · DISCREET · SECURE
        </p>
      </div>
    </div>
  );
}
