import { useRef, useState } from "react";
import { useSignUp } from "@clerk/react/legacy";
import { useAuth } from "@clerk/react";
import { Link } from "wouter";
import { useBrand } from "@/contexts/BrandContext";
import {
  clerkRegistrationErrorKind,
  readSignUpProgress,
  signUpNeedsEmailCode,
  signUpNeedsFullName,
  signUpNeedsLegalAcceptance,
  signUpNeedsPassword,
  signUpReadyToFinish,
  splitFullName,
  verifiedSignUpBlocker,
} from "@/lib/registrationFlow";

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
  unverifiedFields?: string[];
  verifications?: { emailAddress?: { status?: string | null } | null } | null;
};

const memberFieldStyle = {
  background: "#ffffff",
  border: "1px solid #111111",
  color: "#111111",
} as const;

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
  if (errorKind === "already_verified") return "Your email is already verified. Continue below to finish access setup. You do not need another code.";
  if (errorKind === "duplicate_identity") return "This address cannot be registered here. Try signing in or contact support for help.";
  const clerkMessage = errors?.[0]?.longMessage ?? errors?.[0]?.message;
  if (clerkMessage) return clerkMessage;
  return err instanceof Error ? err.message : "Something went wrong";
}

function LegalAcceptance({
  checked,
  onChange,
  required = true,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  required?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 text-[11px] font-mono" style={{ color: "#f0f0f0" }}>
      <input
        id="signup-legal-accepted"
        type="checkbox"
        required={required}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        data-testid="signup-legal-accepted"
        className="mt-0.5"
      />
      <span>
        <label htmlFor="signup-legal-accepted">I agree to the membership terms.</label>
        {" "}
        <a href={`${basePath}/terms-of-service`} className="underline" style={{ color: "#ff526b" }}>
          Read terms
        </a>
      </span>
    </div>
  );
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
  const [emailAlreadyVerified, setEmailAlreadyVerified] = useState(false);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const submitting = useRef(false);

  function legalAcceptanceRequiredMessage(): string {
    return "Accept the membership terms to finish creating your account.";
  }

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

  function rememberRequest(values: WaitlistForm) {
    // Persist only non-secret request details. Never persist the password or code.
    sessionStorage.setItem("myorder.pending-access-request", JSON.stringify({
      name: values.name, email: values.email, phone: values.phone, message: values.message,
    }));
    setSubmittedForm(values);
  }

  async function reloadSignUp(): Promise<ClerkSignUpLike> {
    if (!signUp) throw new Error("Sign-up is not ready. Refresh the page and try again.");
    const reloaded = await signUp.reload();
    return (reloaded ?? signUp) as ClerkSignUpLike;
  }

  async function finishClerkSignUp(result: ClerkSignUpLike, values: WaitlistForm, imageId: string) {
    const progress = readSignUpProgress(result);
    if (!signUpReadyToFinish(progress)) {
      throw new Error(verifiedSignUpBlocker(progress));
    }
    // Verified email alone is not a session. Activate only the session Clerk issued.
    rememberRequest(values);
    setAwaitingVerification(true);
    setVerificationCode("");
    setStatus("loading");
    const sessionId = result.createdSessionId ?? signUp?.createdSessionId;
    if (sessionId && setActive) {
      await setActive({ session: sessionId });
    }
    await submitAccessRequest(values, imageId);
    sessionStorage.removeItem("myorder.pending-access-request");
    setAwaitingVerification(false);
    setStatus("success");
  }

  async function submitVerifiedPassword(password: string): Promise<ClerkSignUpLike> {
    const current = await reloadSignUp();
    if (signUpReadyToFinish(readSignUpProgress(current))) return current;
    try {
      await signUp?.update({ password });
    } catch (err) {
      const after = await reloadSignUp();
      if (!signUpNeedsPassword(readSignUpProgress(after))) return after;
      throw err;
    }
    return reloadSignUp();
  }

  async function acceptLegalIfRequired(progress: ReturnType<typeof readSignUpProgress>): Promise<ClerkSignUpLike | null> {
    if (signUpReadyToFinish(progress) || !signUpNeedsLegalAcceptance(progress)) return null;
    if (!legalAccepted) throw new Error(legalAcceptanceRequiredMessage());
    await signUp?.update({ legalAccepted: true });
    return reloadSignUp();
  }

  async function advanceVerifiedSignUp(values: WaitlistForm, imageId: string) {
    let current = await reloadSignUp();
    let progress = readSignUpProgress(current);
    const names = splitFullName(values.name);
    if (!signUpReadyToFinish(progress) && names && (signUpNeedsFullName(progress) || !signUpNeedsEmailCode(progress))) {
      await signUp?.update({ firstName: names.firstName, lastName: names.lastName });
      current = await reloadSignUp();
      progress = readSignUpProgress(current);
    }
    const accepted = await acceptLegalIfRequired(progress);
    if (accepted) {
      current = accepted;
      progress = readSignUpProgress(current);
    }
    if (signUpReadyToFinish(progress)) {
      await finishClerkSignUp(current, values, imageId);
      return;
    }
    if (!names || signUpNeedsFullName(progress)) setAwaitingVerification(false);
    throw new Error(verifiedSignUpBlocker(progress));
  }

  async function prepareEmailCode(values: WaitlistForm, imageId: string) {
    if (!signUp) return;
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      rememberRequest(values);
      setAwaitingVerification(true);
      setEmailAlreadyVerified(false);
      setStatus("idle");
    } catch (err) {
      if (clerkRegistrationErrorKind(err) !== "already_verified") throw err;
      setEmailAlreadyVerified(true);
      setAwaitingVerification(true);
      const typedPassword = form.password.trim();
      if (typedPassword.length >= 8) await submitVerifiedPassword(typedPassword);
      await advanceVerifiedSignUp(values, imageId);
    }
  }

  async function continueSignUp(result: ClerkSignUpLike, values: WaitlistForm, imageId: string) {
    let progress = readSignUpProgress(result);
    if (signUpReadyToFinish(progress)) {
      await finishClerkSignUp(result, values, imageId);
      return;
    }
    if (signUpNeedsFullName(progress)) {
      const names = splitFullName(values.name);
      if (!names) {
        setAwaitingVerification(false);
        throw new Error("Enter your first and last name.");
      }
      await signUp?.update({ firstName: names.firstName, lastName: names.lastName });
      const refreshed = await reloadSignUp();
      progress = readSignUpProgress(refreshed);
      if (signUpReadyToFinish(progress)) {
        await finishClerkSignUp(refreshed, values, imageId);
        return;
      }
    }
    const accepted = await acceptLegalIfRequired(progress);
    if (accepted) {
      progress = readSignUpProgress(accepted);
      if (signUpReadyToFinish(progress)) {
        await finishClerkSignUp(accepted, values, imageId);
        return;
      }
    }
    if (progress.emailVerificationStatus === "verified") {
      setEmailAlreadyVerified(true);
      await advanceVerifiedSignUp(values, imageId);
      return;
    }
    if (signUpNeedsEmailCode(progress) || progress.status === "missing_requirements") {
      await prepareEmailCode(values, imageId);
      return;
    }
    throw new Error(verifiedSignUpBlocker(progress));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signUp || submitting.current) return;
    setStatus("loading");
    setErrorMsg("");

    const sessionReady = signUpReadyToFinish(readSignUpProgress(signUp));
    const requestValues = sessionReady ? (submittedForm ?? readPendingRequest() ?? form) : form;
    const names = splitFullName(requestValues.name);
    const password = form.password.trim();
    if (!sessionReady && !names) {
      setErrorMsg("Enter your first and last name.");
      setStatus("error");
      return;
    }
    if (!sessionReady && password.length < 8) {
      setErrorMsg("Password must be at least 8 characters.");
      setStatus("error");
      return;
    }
    if (!sessionReady && password !== form.confirmPassword.trim()) {
      setErrorMsg("Passwords do not match.");
      setStatus("error");
      return;
    }
    if (!sessionReady && !legalAccepted) {
      setErrorMsg(legalAcceptanceRequiredMessage());
      setStatus("error");
      return;
    }

    submitting.current = true;
    try {
      const imageId = await ensureProfileImage(requestValues.email);
      if (sessionReady) {
        await finishClerkSignUp(signUp, requestValues, imageId);
        return;
      }
      if (signUp.status === "missing_requirements") {
        if (names) await signUp.update({ firstName: names.firstName, lastName: names.lastName });
        const resumed = readSignUpProgress(await reloadSignUp());
        if (!signUpReadyToFinish(resumed) && (signUpNeedsPassword(resumed) || resumed.emailVerificationStatus === "verified")) {
          await submitVerifiedPassword(password);
        }
        await continueSignUp(await reloadSignUp(), requestValues, imageId);
        return;
      }
      const created = await signUp.create({
        emailAddress: requestValues.email.trim(),
        password,
        firstName: names!.firstName,
        lastName: names!.lastName,
        legalAccepted: true,
        unsafeMetadata: {
          contactPhone: requestValues.phone.trim() || undefined,
          accessRequest: true,
        },
      });
      await continueSignUp(created, requestValues, imageId);
    } catch (err) {
      if (clerkRegistrationErrorKind(err) === "already_verified") {
        try {
          setEmailAlreadyVerified(true);
          const imageId = await ensureProfileImage(requestValues.email);
          await submitVerifiedPassword(password);
          await advanceVerifiedSignUp(requestValues, imageId);
          return;
        } catch (recoverErr) {
          setErrorMsg(recoverErr instanceof Error ? recoverErr.message : getClerkErrorMessage(recoverErr));
          setStatus("error");
          return;
        }
      }
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
    const progress = readSignUpProgress(signUp);
    const password = form.password.trim();
    if (!signUpReadyToFinish(progress)) {
      if (password.length < 8) {
        setErrorMsg("Password must be at least 8 characters.");
        setStatus("error");
        return;
      }
      if (password !== form.confirmPassword.trim()) {
        setErrorMsg("Passwords do not match.");
        setStatus("error");
        return;
      }
    }
    submitting.current = true;
    setStatus("loading");
    setErrorMsg("");

    try {
      const imageId = await ensureProfileImage(values.email);
      if (signUpReadyToFinish(progress)) {
        await finishClerkSignUp(signUp, values, imageId);
        return;
      }
      let attempted: ClerkSignUpLike | null = null;
      if (!emailAlreadyVerified) {
        try {
          attempted = await signUp.attemptEmailAddressVerification({ code: verificationCode.trim() });
        } catch (err) {
          if (clerkRegistrationErrorKind(err) !== "already_verified") throw err;
          setEmailAlreadyVerified(true);
        }
      }
      if (attempted && signUpReadyToFinish(readSignUpProgress(attempted))) {
        await finishClerkSignUp(attempted, values, imageId);
        return;
      }
      const withPassword = await submitVerifiedPassword(password);
      if (signUpReadyToFinish(readSignUpProgress(withPassword))) {
        await finishClerkSignUp(withPassword, values, imageId);
        return;
      }
      await advanceVerifiedSignUp(values, imageId);
    } catch (err) {
      const ownMessage = err instanceof Error ? err.message : "";
      setErrorMsg(clerkRegistrationErrorKind(err) == null && ownMessage
        ? ownMessage
        : signUp.status === "complete"
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
      setEmailAlreadyVerified(false);
      setStatus("idle");
    } catch (err) {
      if (clerkRegistrationErrorKind(err) === "already_verified") {
        setEmailAlreadyVerified(true);
        setErrorMsg("Your email is already verified. Submit this form to finish access setup. You do not need another code.");
        setStatus("error");
        return;
      }
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
            <div className="font-bold tracking-[0.2em] text-base" style={{ color: "#ffffff" }}>
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
            <p className="text-sm font-mono" style={{ color: "#ffffff" }}>
              Account created.
            </p>
            <p className="text-xs font-mono" style={{ color: "#f0f0f0" }}>
              Your access request is waiting for approval.
            </p>
            <Link
              href={`${basePath}/sign-in`}
              className="text-xs font-mono underline mt-2"
              style={{ color: "#ff526b" }}
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
            <p className="text-xs font-mono tracking-widest uppercase mb-1" style={{ color: "#ffffff" }}>
              Verify Email
            </p>

            <label className="text-xs font-mono" style={{ color: "#ffffff" }} htmlFor="verify-profile-picture">
              Profile picture (required)
            </label>
            <input id="verify-profile-picture" type="file" accept="image/png,image/jpeg,image/webp" required={!profileImageUploadId} onChange={(e) => {
              setProfileImageFile(e.target.files?.[0] ?? null);
              setProfileImageUploadId(null);
              setProfileImageEmail("");
              setImageStatus("idle");
            }} aria-describedby="verify-profile-picture-help" className="w-full text-xs font-mono text-white file:mr-3 file:rounded file:border-0 file:bg-[#8b0000] file:px-3 file:py-2 file:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#dc143c]" />
            <p id="verify-profile-picture-help" className="text-[11px] font-mono" style={{ color: imageStatus === "error" ? "#ff8a9a" : "#f0f0f0" }}>
              {imageStatus === "ready" ? "Image uploaded securely." : imageStatus === "uploading" ? "Validating image…" : "PNG, JPEG, or WebP, up to 3 MB. Choose again after a page refresh."}
            </p>

            {signUp?.status !== "complete" && !emailAlreadyVerified && <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Verification code"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono placeholder:text-[#444] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={memberFieldStyle}
            />}

            {signUp?.status !== "complete" && <>
              <input
                required
                type="password"
                autoComplete="new-password"
                placeholder="Password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                data-testid="signup-finish-password"
                className="w-full rounded-lg px-3 py-2 text-sm font-mono placeholder:text-[#444] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
                style={memberFieldStyle}
              />
              <input
                required
                type="password"
                autoComplete="new-password"
                placeholder="Confirm password"
                value={form.confirmPassword}
                onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                data-testid="signup-finish-password-confirm"
                className="w-full rounded-lg px-3 py-2 text-sm font-mono placeholder:text-[#444] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
                style={memberFieldStyle}
              />
              <p className="text-[11px] font-mono" style={{ color: "#f0f0f0" }}>
                This password creates the sign-in. Access stays pending until an admin approves the account.
              </p>
            </>}

            <LegalAcceptance checked={legalAccepted} onChange={setLegalAccepted} />

            {status === "error" && (
              <p className="text-xs font-mono" style={{ color: "#DC143C" }}>
                {errorMsg}
              </p>
            )}
            {status === "error" && signUp?.status !== "complete" && !emailAlreadyVerified && (
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
                color: "#ffffff",
                opacity: status === "loading" ? 0.6 : 1,
              }}
            >
              {status === "loading" ? "Finishing…" : signUp?.status === "complete" || emailAlreadyVerified ? "Finish access setup" : "Verify & Request Access"}
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
            <p className="text-xs font-mono tracking-widest uppercase mb-1" style={{ color: "#ffffff" }}>
              Request Access
            </p>

            <label className="text-xs font-mono" style={{ color: "#ffffff" }} htmlFor="signup-profile-picture">
              Profile picture (required)
            </label>
            <input id="signup-profile-picture" type="file" accept="image/png,image/jpeg,image/webp" required={!profileImageUploadId} onChange={(e) => {
              setProfileImageFile(e.target.files?.[0] ?? null);
              setProfileImageUploadId(null);
              setProfileImageEmail("");
              setImageStatus("idle");
            }} aria-describedby="signup-profile-picture-help" className="w-full text-xs font-mono text-white file:mr-3 file:rounded file:border-0 file:bg-[#8b0000] file:px-3 file:py-2 file:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#dc143c]" />
            <p id="signup-profile-picture-help" className="text-[11px] font-mono" style={{ color: imageStatus === "error" ? "#ff8a9a" : "#f0f0f0" }}>
              {imageStatus === "ready" ? "Image uploaded securely." : imageStatus === "uploading" ? "Validating image…" : "PNG, JPEG, or WebP, up to 3 MB."}
            </p>

            {signUp?.status !== "complete" && <input
              required
              type="text"
              autoComplete="name"
              placeholder="First and last name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono placeholder:text-[#444] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={memberFieldStyle}
            />}

            <input
              required={signUp?.status !== "complete"}
              type="email"
              placeholder="Email address"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono placeholder:text-[#444] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={memberFieldStyle}
            />

            <input
              type="tel"
              placeholder="Phone"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono placeholder:text-[#444] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={memberFieldStyle}
            />

            <input
              required={signUp?.status !== "complete"}
              type="password"
              autoComplete="new-password"
              placeholder="Password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono placeholder:text-[#444] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={memberFieldStyle}
            />

            <input
              required
              type="password"
              autoComplete="new-password"
              placeholder="Confirm password"
              value={form.confirmPassword}
              onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono placeholder:text-[#444] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={memberFieldStyle}
            />

            <textarea
              placeholder="Message (optional)"
              value={form.message}
              onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
              rows={3}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono placeholder:text-[#444] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c] resize-none"
              style={memberFieldStyle}
            />

            {status === "error" && errorMsg === "CAPTCHA_ERROR" && (
              <div
                className="w-full rounded-lg p-3 text-xs font-mono flex flex-col gap-2"
                style={{ background: "rgba(139,0,0,0.15)", border: "1px solid rgba(220,20,60,0.3)", color: "#C0C0C0" }}
              >
                <p style={{ color: "#DC143C" }}>⚠ Security check couldn't load</p>
                <p style={{ color: "#ffffff" }}>Your browser blocked the sign-up security check. Use the link below to register instead.</p>
                <Link href={`${basePath}/sign-up`} className="underline font-bold" style={{ color: "#ff526b" }}>
                  → Sign up via secure portal
                </Link>
              </div>
            )}
            <LegalAcceptance checked={legalAccepted} onChange={setLegalAccepted} required={signUp?.status !== "complete"} />

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
                color: "#ffffff",
                opacity: status === "loading" ? 0.6 : 1,
              }}
            >
              {status === "loading" ? "Sending…" : "Request Access"}
            </button>

            <Link
              href={`${basePath}/sign-in`}
              className="text-center text-xs font-mono mt-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#dc143c]"
              style={{ color: "#ffffff" }}
            >
              Already have access?{" "}
              <span style={{ color: "#ff526b", textDecoration: "underline" }}>Sign in</span>
            </Link>
          </form>
        )}

        <p className="text-[10px] font-mono" style={{ color: "#f0f0f0" }}>
          ADULTS ONLY · 18+ · DISCREET · SECURE
        </p>
      </div>
    </div>
  );
}
