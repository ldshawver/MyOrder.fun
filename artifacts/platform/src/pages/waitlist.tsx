import { useState } from "react";
import { useSignUp } from "@clerk/react/legacy";
import { Link } from "wouter";

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

function getClerkErrorMessage(err: unknown): string {
  const errors = (err as { errors?: Array<{ longMessage?: string; message?: string }> })?.errors;
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

export default function WaitlistPage() {
  const { isLoaded, signUp, setActive } = useSignUp();
  const [form, setForm] = useState<WaitlistForm>({
    name: "",
    email: "",
    phone: "",
    password: "",
    confirmPassword: "",
    message: "",
  });
  const [verificationCode, setVerificationCode] = useState("");
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const [submittedForm, setSubmittedForm] = useState<WaitlistForm | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function submitAccessRequest(values: WaitlistForm) {
    const res = await fetch(`${BASE_API}/api/onboarding/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contactName: values.name,
        contactEmail: values.email,
        contactPhone: values.phone || undefined,
        description: values.message || undefined,
        companyName: "Individual",
        businessType: "customer",
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Request failed");
    }
  }

  async function finishClerkSignUp(result: ClerkSignUpLike, values: WaitlistForm) {
    if (result.status === "complete") {
      await submitAccessRequest(values);
      if (result.createdSessionId && setActive) {
        await setActive({ session: result.createdSessionId });
      }
      setStatus("success");
      return;
    }

    if (result.status === "missing_requirements" || result.missingFields?.includes("email_address_verification")) {
      await signUp?.prepareEmailAddressVerification({ strategy: "email_code" });
      setSubmittedForm(values);
      setAwaitingVerification(true);
      setStatus("idle");
      return;
    }

    throw new Error("Sign up needs additional verification. Please use the Clerk sign up link below.");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signUp) return;
    setStatus("loading");
    setErrorMsg("");

    const password = form.password.trim();
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

    try {
      const { firstName, lastName } = splitName(form.name);
      const result = await signUp.create({
        emailAddress: form.email.trim(),
        password,
        firstName,
        lastName,
        unsafeMetadata: {
          contactPhone: form.phone.trim() || undefined,
          accessRequest: true,
        },
      });
      await finishClerkSignUp(result, form);
    } catch (err) {
      setErrorMsg(getClerkErrorMessage(err));
      setStatus("error");
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || !signUp || !submittedForm) return;
    setStatus("loading");
    setErrorMsg("");

    try {
      const result = await signUp.attemptEmailAddressVerification({
        code: verificationCode.trim(),
      });
      await finishClerkSignUp(result, submittedForm);
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
            src={`${basePath}/lc-icon.png`}
            alt="Lucifer Cruz"
            className="w-12 h-12 object-contain"
            style={{ filter: "invert(1) brightness(1.2)" }}
          />
          <div className="text-center">
            <div className="font-bold tracking-[0.2em] text-base" style={{ color: "#C0C0C0" }}>
              LUCIFER CRUZ
            </div>
            <div className="text-[10px] font-mono tracking-[0.35em] uppercase mt-0.5" style={{ color: "#8B0000" }}>
              Adult Boutique · 18+
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

            <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Verification code"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono outline-none"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#C0C0C0",
              }}
            />

            {status === "error" && (
              <p className="text-xs font-mono" style={{ color: "#DC143C" }}>
                {errorMsg}
              </p>
            )}

            <button
              type="submit"
              disabled={status === "loading"}
              className="w-full rounded-lg py-2 text-sm font-mono tracking-widest uppercase transition-opacity"
              style={{
                background: "#8B0000",
                color: "#C0C0C0",
                opacity: status === "loading" ? 0.6 : 1,
              }}
            >
              {status === "loading" ? "Verifying…" : "Verify & Request Access"}
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

            <input
              required
              type="text"
              placeholder="Full name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono outline-none"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#C0C0C0",
              }}
            />

            <input
              required
              type="email"
              placeholder="Email address"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono outline-none"
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
              className="w-full rounded-lg px-3 py-2 text-sm font-mono outline-none"
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
              placeholder="Password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              className="w-full rounded-lg px-3 py-2 text-sm font-mono outline-none"
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
              className="w-full rounded-lg px-3 py-2 text-sm font-mono outline-none"
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
              className="w-full rounded-lg px-3 py-2 text-sm font-mono outline-none resize-none"
              style={{
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#C0C0C0",
              }}
            />

            {status === "error" && (
              <p className="text-xs font-mono" style={{ color: "#DC143C" }}>
                {errorMsg}
              </p>
            )}

            <button
              type="submit"
              disabled={status === "loading"}
              className="w-full rounded-lg py-2 text-sm font-mono tracking-widest uppercase transition-opacity"
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
              className="text-center text-xs font-mono mt-1"
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
